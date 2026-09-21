import type { Ctx } from '../context';
import type { TrackerName } from '../config/schema';
import type { DropEvent, MarkEvent, ResumeEntry, ScrobbleEvent, Tracker } from '../trackers/types';
import { sha256 } from '../util/bytes';
import { registerAccount } from './state';
import { historyStatement } from './history';
import { dropTargets, trackerTargets } from '../trackers/targets';
import { hasDatabaseBudget, cleanupDatabase, DatabaseBudgetExceeded } from './budget';
import { dropStatement, localDrop } from './dropped';
import { ratingStatement } from './ratings';
import { cacheDelete } from '../util/cache';

type Operation = 'scrobble' | 'mark' | 'clear' | 'drop';
type Event = ScrobbleEvent | MarkEvent | ResumeEntry | DropEvent;
interface Job { id: string; scope: string; service: TrackerName; operation: Operation; payload: string; created: number; attempts: number }

export async function enqueue(ctx: Ctx, operation: Operation, event: Event, targets: Tracker[]): Promise<void> {
  const db = ctx.env.DB;
  if (!db) throw new Error('Durable storage is required');
  await registerAccount(ctx);
  const identity = operation !== 'clear' ? (event as ScrobbleEvent | MarkEvent).deliveryId || crypto.randomUUID() : crypto.randomUUID();
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  if (operation==='scrobble' && !targets.length) {
    const id=await sha256(`${ctx.scope}:local:${identity}`);
    statements.push(db.prepare("INSERT INTO deliveries(id,scope,service,operation,payload,created,due,status) VALUES(?,?,'local',?,?,?,?,'done') ON CONFLICT(id) DO NOTHING")
      .bind(id,ctx.scope,operation,JSON.stringify(event),now,now));
  }
  for (const t of targets) {
    const id = await sha256(`${ctx.scope}:${operation}:${t.name}:${identity}`);
    statements.push(db.prepare('INSERT INTO deliveries(id,scope,service,operation,payload,created,due) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .bind(id,ctx.scope,t.name,operation,JSON.stringify(event),now,now));
  }
  const local = operation === 'drop' ? dropStatement(ctx, event as DropEvent)
    : historyStatement(ctx,event as Exclude<Event, DropEvent>,operation === 'scrobble' ? 'progress' : operation === 'mark' ? 'mark' : 'clear');
  if (local) statements.push(local);
  const rating = operation === 'drop' ? (event as DropEvent).rating : undefined;
  if (rating) statements.push(ratingStatement(ctx, rating.itemId, rating.likes, rating.profile));
  if (statements.length) await db.batch(statements);
}

export async function drain(ctx: Ctx, registry: Record<TrackerName, Tracker>, limit = 2): Promise<void> {
  const db = ctx.env.DB;
  if (!db) return;
  for (let n = 0; n < limit; n++) {
    if(!hasDatabaseBudget(db,18)) return;
    const now = Date.now(), lease = crypto.randomUUID();
    const job = await db.prepare(`UPDATE deliveries SET lease=?,lease_until=?,attempts=attempts+1 WHERE id=(
      SELECT d.id FROM deliveries d WHERE d.scope=? AND d.status='pending' AND d.due<=? AND d.lease_until<=?
      AND NOT EXISTS (SELECT 1 FROM deliveries p WHERE p.scope=d.scope AND p.service=d.service AND p.status='pending'
        AND (p.created<d.created OR (p.created=d.created AND p.rowid<d.rowid)))
      ORDER BY d.created,d.rowid LIMIT 1) RETURNING id,scope,service,operation,payload,created,attempts`)
      .bind(lease,now + 180_000,ctx.scope,now,now).first<Job>();
    if (!job) return;
    try {
      const tracker = registry[job.service];
      if (!tracker?.ready(ctx)) throw new Error('Tracker disconnected');
      const event = JSON.parse(job.payload) as Event;
      let stale = job.operation === 'scrobble' && (event as ScrobbleEvent).action !== 'stop' && now - job.created > 10 * 60_000;
      if (job.operation === 'drop') {
        const ev = event as DropEvent;
        const current = await localDrop({ ...ctx, historyScope: ev.scope }, ev.ids);
        stale = !!current && current.updated > ev.at;
      }
      if (!stale) {
        if (job.operation === 'drop') {
          if (!tracker.drop) throw new Error('Tracker does not support dropping shows');
          for (const target of await dropTargets(ctx, event as DropEvent, tracker.name)) await tracker.drop(ctx, target);
          await cacheDelete(`tracker-snapshot:${ctx.scope}:${ctx.cacheRevision ?? ctx.cfgToken}:${tracker.name}`, ctx.origin, ctx.env.DB);
        } else if (job.operation === 'clear') await tracker.clearResume?.(ctx,event as ResumeEntry);
        else {
          const events = await trackerTargets(ctx,event as ScrobbleEvent | MarkEvent,job.service);
          for (let i = 0; i < events.length; i++) {
            if(!hasDatabaseBudget(db,15)) throw new DatabaseBudgetExceeded();
            const ack = `delivery:${job.id}:${i}`;
            if (await db.prepare('SELECT key FROM state WHERE key=?').bind(ack).first()) continue;
            const renewed = await db.prepare('UPDATE deliveries SET lease_until=? WHERE id=? AND lease=?')
              .bind(Date.now()+180_000,job.id,lease).run();
            if (!renewed.meta.changes) return;
            if (job.operation === 'scrobble') await tracker.scrobble(ctx,events[i] as ScrobbleEvent);
            else await tracker.mark(ctx,events[i] as MarkEvent);
            // A stop report from a player already running when the user dropped a show
            // must not let the tracker's automatic watched-event undrop reverse that choice.
            if (tracker.drop && (event as MarkEvent).kind !== 'movie') {
              const dropped = await localDrop(ctx, event.ids);
              if (dropped?.dropped) await tracker.drop(ctx, { ids: { ...dropped.bundle, ...events[i].ids }, dropped: true, at: dropped.updated, scope: ctx.scope });
            }
            await db.prepare('INSERT INTO state(key,value,expires) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING')
              .bind(ack,'true',Date.now()+30*86400_000).run();
          }
        }
      }
      await db.prepare('UPDATE deliveries SET status=?,lease=NULL,lease_until=0 WHERE id=? AND lease=?')
        .bind(stale ? 'superseded' : 'done',job.id,lease).run();
    } catch(error) {
      if(error instanceof DatabaseBudgetExceeded) {
        await cleanupDatabase(db).prepare('UPDATE deliveries SET attempts=MAX(0,attempts-1),lease=NULL,lease_until=0 WHERE id=? AND lease=?').bind(job.id,lease).run();
        return;
      }
      await cleanupDatabase(db).prepare('UPDATE deliveries SET status=?,due=?,lease=NULL,lease_until=0 WHERE id=? AND lease=?')
        .bind(job.attempts >= 10 ? 'failed' : 'pending',Date.now()+Math.min(6*3600_000,30_000*2**(job.attempts-1)),job.id,lease).run();
      console.warn('Tracking delivery pending', { service:job.service, attempt:job.attempts });
    }
  }
}

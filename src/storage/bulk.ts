import type { Ctx } from '../context';
import type { MarkEvent } from '../trackers/types';
import { registerAccount } from './state';
import { profileContext } from '../jellyfin/profiles';
import { restoreDroppedShow, trackerApi } from '../trackers/index';
import { saveHistory } from './history';
import { hasDatabaseBudget, cleanupDatabase } from './budget';

export async function queueBulk(ctx: Ctx, events: MarkEvent[]): Promise<void> {
  if (!ctx.env.DB || !events.length) return;
  for (const ev of events) if (ev.kind !== 'movie' && ev.watched) await restoreDroppedShow(ctx, ev.ids);
  await registerAccount(ctx);
  const id=crypto.randomUUID(), now=Date.now();
  const stamped=events.map(e => ({...e,at:new Date(now).toISOString()}));
  const statements=[ctx.env.DB.prepare('INSERT INTO bulk_actions(id,scope,profile_id,events,created) VALUES(?,?,?,?,?)')
    .bind(id,ctx.scope,ctx.profile?.id ?? null,JSON.stringify(stamped),now)];
  for(const tracker of trackerApi.sinks(ctx)) {
    const selected=stamped.filter(e => ctx.cfg.trackers.media?.[tracker.name]?.[e.kind === 'movie' ? 'movie' : 'series'] !== false);
    if (!selected.length) continue;
    statements.push(ctx.env.DB.prepare(`INSERT INTO deliveries(id,scope,service,operation,payload,created,due)
      SELECT ? || ':' || key,?,?,'mark',value,?,? FROM json_each(?)`)
      .bind(`bulk:${id}:${tracker.name}`,ctx.scope,tracker.name,now,now,JSON.stringify(selected)));
  }
  await ctx.env.DB.batch(statements);
}

export async function advanceBulk(ctx: Ctx, limit=20): Promise<void> {
  const db=ctx.env.DB;
  if (!db) return;
  const lease=crypto.randomUUID();
  const row=await db.prepare(`UPDATE bulk_actions SET lease=?,lease_until=? WHERE id=(SELECT id FROM bulk_actions WHERE scope=? AND status='pending' AND lease_until<=? ORDER BY created,rowid LIMIT 1) RETURNING id,profile_id,events,position`)
    .bind(lease,Date.now()+180_000,ctx.scope,Date.now()).first<{id:string;profile_id:string|null;events:string;position:number}>();
  if (!row) return;
  try {
    const scoped=profileContext(ctx,row.profile_id ?? undefined);
    if (!scoped) { await db.prepare("UPDATE bulk_actions SET status='cancelled' WHERE id=? AND lease=?").bind(row.id,lease).run();return; }
    const events=JSON.parse(row.events) as MarkEvent[];
    const end=Math.min(events.length,row.position+limit);
    for(let i=row.position;i<end;i++) {
      if(!hasDatabaseBudget(db,4)) break;
      await saveHistory(scoped,events[i],'mark');
      await db.prepare('UPDATE bulk_actions SET position=?,lease_until=? WHERE id=? AND lease=?').bind(i+1,Date.now()+180_000,row.id,lease).run();
    }
    await db.prepare("UPDATE bulk_actions SET status='done' WHERE id=? AND lease=? AND position>=?").bind(row.id,lease,events.length).run();
  } finally { await cleanupDatabase(db).prepare('UPDATE bulk_actions SET lease=NULL,lease_until=0 WHERE id=? AND lease=?').bind(row.id,lease).run(); }
}

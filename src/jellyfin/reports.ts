import type { Ctx } from '../context';
import { budgetDatabase, hasDatabaseBudget, DatabaseBudgetExceeded, cleanupDatabase } from '../storage/budget';
import { StateLockBusy, withStateLock } from '../storage/lock';
import { drainTracking } from '../trackers/index';
import { identityOf } from './auth';
import { Library } from './library';
import { profileContext } from './profiles';
import { applyPlaybackReport, cursorKey, type PlayReport } from './sessions';

type Action = 'start' | 'progress' | 'stop';
interface QueuedReport {
  id: number;
  profile_id: string | null;
  device_id: string;
  action: Action;
  report: string;
  due: number;
}

async function processSession(ctx: Ctx, key: string, limit = 4): Promise<void> {
  if (!ctx.env.DB) return;
  // Leave room for authentication and durable receipt in the HTTP invocation.
  // Scheduled invocations already carry a shared budget, which is preserved.
  const db = budgetDatabase(ctx.env.DB, ctx.env.D1_QUERY_BUDGET === '1000' ? 990 : 40);
  if (!hasDatabaseBudget(db, 20)) return;
  ctx = { ...ctx, env: { ...ctx.env, DB: db } };
  let current: QueuedReport | undefined;
  try {
    await withStateLock(ctx, key, async () => {
      for (let i = 0; i < limit && hasDatabaseBudget(db, 18); i++) {
        const row = await db.prepare('SELECT id,profile_id,device_id,action,report,due FROM playback_reports WHERE scope=? AND session_key=? ORDER BY id LIMIT 1')
          .bind(ctx.scope, key).first<QueuedReport>();
        if (!row || row.due > Date.now()) break;
        current = row;
        const scoped = profileContext(ctx, row.profile_id ?? undefined);
        if (scoped) {
          // Saving local history and queuing deliveries happen under the lock;
          // network delivery to trackers happens after the lock is released.
          const reportCtx = { ...scoped, queueOnly: true };
          const lib = new Library({
            ctx: reportCtx, who: await identityOf(reportCtx), claims: null,
            client: { client: 'Rill', device: 'Playback report', deviceId: row.device_id, version: '1' },
            base: ctx.origin, rawPath: '', q: () => undefined, body: {},
          });
          await applyPlaybackReport(lib, JSON.parse(row.report) as PlayReport, row.action);
        }
        await db.prepare('DELETE FROM playback_reports WHERE id=? AND scope=?').bind(row.id, ctx.scope).run();
        current = undefined;
      }
    }, 0);
    if (ctx.defer) ctx.defer(drainTracking(ctx, 2));
  } catch (error) {
    if (error instanceof StateLockBusy || error instanceof DatabaseBudgetExceeded) return;
    if (current) {
      await cleanupDatabase(db).prepare('UPDATE playback_reports SET due=? WHERE id=? AND scope=?')
        .bind(Date.now() + 30_000, current.id, ctx.scope).run();
    }
    console.warn('Playback report retained for retry');
  }
}

async function receive(lib: Library, report: PlayReport, action: Action): Promise<void> {
  const ctx = lib.ctx, db = ctx.env.DB;
  if (!db) return applyPlaybackReport(lib, report, action);
  const now = Date.now(), key = cursorKey(lib, report);
  await db.prepare('INSERT INTO playback_reports(scope,session_key,profile_id,device_id,action,report,due) VALUES(?,?,?,?,?,?,?)')
    .bind(ctx.scope, key, ctx.profile?.id ?? null, lib.jf.client.deviceId, action,
      JSON.stringify({ ...report, at: new Date(now).toISOString() }), now).run();
  // Acknowledge only after durable receipt. A busy or interrupted consumer can
  // leave without losing the final stop; the scheduled worker resumes it.
  const work = processSession(ctx, key);
  if (ctx.defer) ctx.defer(work);
  else await work;
}

export const onPlaying = (lib: Library, report: PlayReport) => receive(lib, report, 'start');
export const onProgress = (lib: Library, report: PlayReport) => receive(lib, report, 'progress');
export const onStopped = (lib: Library, report: PlayReport) => receive(lib, report, 'stop');

export async function drainPlaybackReports(ctx: Ctx): Promise<void> {
  const db = ctx.env.DB;
  if (!db || !hasDatabaseBudget(db, 21)) return;
  const row = await db.prepare(`SELECT r.session_key FROM playback_reports r WHERE r.scope=? AND r.due<=?
    AND r.id=(SELECT MIN(p.id) FROM playback_reports p WHERE p.scope=r.scope AND p.session_key=r.session_key)
    AND NOT EXISTS (SELECT 1 FROM state s WHERE s.key='lock:' || r.session_key AND s.expires>?)
    ORDER BY r.id LIMIT 1`).bind(ctx.scope, Date.now(), Date.now()).first<{ session_key: string }>();
  if (row) await processSession(ctx, row.session_key);
}

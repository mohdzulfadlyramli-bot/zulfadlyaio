import type { Env } from '../env';
import type { Ctx } from '../context';
import { decodeConfig } from '../config/codec';
import { drainTracking, trackerApi } from '../trackers/index';
import { saveSnapshot } from './snapshots';
import { advanceBulk } from './bulk';
import { sha256 } from '../util/bytes';
import { budgetDatabase, cleanupDatabase, DatabaseBudgetExceeded, hasDatabaseBudget } from './budget';
import { syncMovieLens } from '../addon/movielens-sync';
import { advanceRecommendations } from './recommendation-jobs';
import { ensureSchema } from './migrate';
import { reconcileDropped } from './dropped';
import { dailyUpdate } from './updates';
import { drainPlaybackReports } from '../jellyfin/reports';

export async function scheduled(event: ScheduledController, env: Env): Promise<void> {
  if (!env.DB) throw new Error('Scheduled synchronization requires DB');
  await ensureSchema(env.DB);
  try { await dailyUpdate(event, env); }
  catch { console.warn('Daily Rill update failed. Check the Deploy Hook in Rill update settings.'); }
  const db=budgetDatabase(env.DB,env.D1_QUERY_BUDGET==='1000'?1000:50);
  env={...env,DB:db};
  const now = Date.now();
  const accounts = await db.prepare(`SELECT scope,config,origin,sync_after FROM accounts WHERE sync_after<=?
    OR scope IN (SELECT scope FROM playback_reports WHERE due<=?)
    OR scope IN (SELECT scope FROM deliveries WHERE status='pending' AND due<=?)
    OR scope IN (SELECT scope FROM bulk_actions WHERE status='pending')
    OR scope IN (SELECT scope FROM recommendation_jobs WHERE status='pending' AND lease_until<=?) ORDER BY processed_at,scope LIMIT 1`)
    .bind(now,now,now,now).all<{scope:string;config:string;origin:string;sync_after:number}>();
  for (const a of accounts.results) {
    const cfg = await decodeConfig(a.config);
    if (!cfg) continue;
    const ctx: Ctx = {cfg,env,cfgToken:a.config,scope:a.scope,cacheRevision:(await sha256(JSON.stringify(cfg))).slice(0,16),origin:a.origin,lang:cfg.language.slice(0,2).toLowerCase(),tmdbKey:cfg.keys.tmdb || env.TMDB_KEY};
    try {
      await db.prepare('UPDATE accounts SET processed_at=? WHERE scope=?').bind(now,a.scope).run();
      await drainPlaybackReports(ctx);
      if(await advanceRecommendations(ctx))continue;
      await advanceBulk(ctx,4);
      await drainTracking(ctx,2);
      if (a.sync_after <= now) {
        if(!hasDatabaseBudget(db,12)) continue;
        const claimed = await db.prepare('UPDATE accounts SET sync_after=? WHERE scope=? AND sync_after<=?').bind(now+30*60_000,a.scope,now).run();
        if (claimed.meta.changes) {
          const tracker = trackerApi.primary(ctx);
          try {
            if (tracker) {
              const snapshot = await tracker.snapshot(ctx);
              await reconcileDropped(ctx, tracker.name, snapshot);
              await saveSnapshot(ctx,`history-import:${ctx.scope}:${tracker.name}`,snapshot);
            }
            await trackerApi.invalidate(ctx);
          } catch(error) {
            await cleanupDatabase(db).prepare('UPDATE accounts SET sync_after=? WHERE scope=?').bind(now+60_000,a.scope).run();
            throw error;
          }
        }
      }
      if(cfg.movieLens?.syncRatings&&hasDatabaseBudget(db,16))await syncMovieLens(ctx);
    } catch(error) { if(!(error instanceof DatabaseBudgetExceeded)) console.warn('Account synchronization failed'); }
  }
  if(!hasDatabaseBudget(db,3)) return;
  await db.batch([
    db.prepare('DELETE FROM state WHERE expires<=?').bind(now),
    db.prepare("DELETE FROM deliveries WHERE status IN ('done','superseded') AND created<?").bind(now-30*86400_000),
    db.prepare("DELETE FROM bulk_actions WHERE status IN ('done','cancelled') AND created<?").bind(now-30*86400_000),
  ]);
}

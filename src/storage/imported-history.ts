import type { Ctx } from '../context';
import type { Tracker, WatchSnapshot } from '../trackers/types';
import { emptySnapshot } from '../trackers/common';
import { cacheGet, cachePut } from '../util/cache';
import { reconcileDropped } from './dropped';
import { loadSnapshot, saveSnapshot } from './snapshots';

const REFRESH_SECONDS = 60;

// Local progress is overlaid by the caller, so serving the last complete
// import never delays a user's own playback updates.
export async function importedHistory(ctx: Ctx, tracker: Tracker, cacheKey: string): Promise<WatchSnapshot> {
  const cached = await cacheGet<WatchSnapshot>(cacheKey);
  if (cached) return cached;
  const durableKey = `history-import:${ctx.scope}:${tracker.name}`;
  const stored = ctx.env.DB ? await loadSnapshot(ctx, durableKey) : null;

  const refresh = async (): Promise<WatchSnapshot> => {
    if (ctx.env.DB) {
      const now = Date.now();
      // Across clients/isolates, only one foreground refresh starts per minute.
      // Keep the cooldown after failures to avoid repeated imports during outages.
      const claimed = await ctx.env.DB.prepare(`INSERT INTO state(key,value,expires) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires=excluded.expires
        WHERE state.expires<=? RETURNING key`)
        .bind(`${durableKey}:refresh`, 'true', now + REFRESH_SECONDS * 1000, now).first();
      if (!claimed) return stored ?? emptySnapshot();
    }
    try {
      const fresh = await tracker.snapshot(ctx);
      await reconcileDropped(ctx, tracker.name, fresh);
      if (ctx.env.DB) await saveSnapshot(ctx, durableKey, fresh);
      await cachePut(cacheKey, fresh, REFRESH_SECONDS);
      return fresh;
    } catch {
      console.warn(`History refresh failed (${tracker.name}); retaining saved history`);
      const fallback = stored ?? emptySnapshot();
      if (!ctx.env.DB) await cachePut(cacheKey, fallback, REFRESH_SECONDS);
      return fallback;
    }
  };

  if (stored) {
    await cachePut(cacheKey, stored, REFRESH_SECONDS);
    const fetchedAt = Date.parse(stored.fetchedAt);
    if (ctx.defer && (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt >= REFRESH_SECONDS * 1000)) {
      // A full import also consumes the browsing request's CPU budget in waitUntil.
      // Let the scheduled worker refresh it while clients use the complete snapshot.
      if (ctx.env.DB) ctx.defer(ctx.env.DB.prepare('UPDATE accounts SET sync_after=MIN(sync_after,?) WHERE scope=?')
        .bind(Date.now(),ctx.scope).run());
      else ctx.defer(refresh());
    }
    return stored;
  }
  // Only the first import needs to wait; existing installations can browse
  // immediately even if the tracker is slow or unavailable.
  return refresh();
}

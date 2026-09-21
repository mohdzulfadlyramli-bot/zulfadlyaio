import type { Ctx } from '../context';
import { decodeGuid, plainGuid } from '../jellyfin/ids';

export async function favoriteIds(ctx: Ctx): Promise<Set<string>> {
  if (!ctx.env.DB) return new Set();
  const rows = await ctx.env.DB.prepare('SELECT item_id FROM favorites WHERE scope=? AND profile=? ORDER BY created_at DESC, item_id')
    .bind(ctx.scope, ctx.profile?.id ?? '').all<{ item_id: string }>();
  return new Set(rows.results.map(row => row.item_id));
}

export async function saveFavorite(ctx: Ctx, rawId: string, favorite: boolean): Promise<void> {
  if (!ctx.env.DB) throw new Error('Durable storage is required to save favorites');
  const id = plainGuid(rawId);
  if (!decodeGuid(id)) throw new Error('Invalid favorite item ID');
  // Favorites belong to the signed-in profile, even when it shares watch history.
  const args = [ctx.scope, ctx.profile?.id ?? '', id];
  if (favorite) {
    await ctx.env.DB.prepare('INSERT INTO favorites(scope,profile,item_id,created_at) VALUES(?,?,?,?) ON CONFLICT(scope,profile,item_id) DO NOTHING')
      .bind(...args, Date.now()).run();
  } else {
    await ctx.env.DB.prepare('DELETE FROM favorites WHERE scope=? AND profile=? AND item_id=?').bind(...args).run();
  }
}

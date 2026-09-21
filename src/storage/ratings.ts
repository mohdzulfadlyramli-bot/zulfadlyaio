import type { Ctx } from '../context';
import { decodeGuid, plainGuid } from '../jellyfin/ids';

export async function itemRatings(ctx: Ctx): Promise<Map<string, boolean>> {
  if (!ctx.env.DB) return new Map();
  const rows = await ctx.env.DB.prepare('SELECT item_id,likes FROM item_ratings WHERE scope=? AND profile=? ORDER BY updated_at DESC, item_id')
    .bind(ctx.scope, ctx.profile?.id ?? '').all<{ item_id: string; likes: number }>();
  return new Map(rows.results.map(row => [row.item_id, row.likes === 1]));
}

export async function saveRating(ctx: Ctx, rawId: string, likes: boolean | null): Promise<void> {
  await ratingStatement(ctx, rawId, likes).run();
}

export function ratingStatement(ctx: Ctx, rawId: string, likes: boolean | null, profile = ctx.profile?.id ?? ''): D1PreparedStatement {
  if (!ctx.env.DB) throw new Error('Durable storage is required to save ratings');
  const id = plainGuid(rawId);
  if (!decodeGuid(id)) throw new Error('Invalid rating item ID');
  // Personal ratings stay separate from shared watch history and favorites.
  const args = [ctx.scope, profile, id];
  if (likes === null) {
    return ctx.env.DB.prepare('DELETE FROM item_ratings WHERE scope=? AND profile=? AND item_id=?').bind(...args);
  } else {
    return ctx.env.DB.prepare('INSERT INTO item_ratings(scope,profile,item_id,likes,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(scope,profile,item_id) DO UPDATE SET likes=excluded.likes,updated_at=excluded.updated_at')
      .bind(...args, likes ? 1 : 0, Date.now());
  }
}

import type { Ctx } from '../context';
import type { IdBundle } from '../meta/types';
import type { DropEvent, WatchSnapshot } from '../trackers/types';
import type { TrackerName } from '../config/schema';
import { titleKey } from '../trackers/common';
import { itemRatings } from './ratings';
import { decodeGuid } from '../jellyfin/ids';

export function showKeys(ids: IdBundle): string[] {
  return Object.entries(ids).filter(([key, value]) => key !== 'tmdbType' && value !== undefined && value !== null)
    .map(([key, value]) => `${key}:${key === 'imdb' ? Number(String(value).replace(/^tt/i, '')) : value}`);
}

export function sameShow(a: IdBundle, b: IdBundle): boolean {
  const keys = new Set(showKeys(a));
  return showKeys(b).some(key => keys.has(key));
}

interface Row { key: string; ids: string; item_id: string | null; dropped: number; updated: number; source: TrackerName | null; confirmed: number }
async function rows(ctx: Ctx): Promise<Row[]> {
  if (!ctx.env.DB) return [];
  return (await ctx.env.DB.prepare('SELECT key,ids,item_id,dropped,updated,source,confirmed FROM dropped_shows WHERE scope=? ORDER BY updated,key')
    .bind(ctx.historyScope ?? ctx.scope).all<Row>()).results;
}

export async function localDrop(ctx: Ctx, ids: IdBundle): Promise<(Row & { bundle: IdBundle }) | null> {
  const found = (await rows(ctx)).map(row => ({ ...row, bundle: JSON.parse(row.ids) as IdBundle })).filter(row => sameShow(row.bundle, ids));
  return found.at(-1) ?? null;
}

export function dropStatement(ctx: Ctx, ev: DropEvent): D1PreparedStatement {
  if (!ctx.env.DB) throw new Error('Durable storage is required to drop shows');
  return ctx.env.DB.prepare(`INSERT INTO dropped_shows(scope,key,ids,item_id,dropped,updated,source,confirmed) VALUES(?,?,?,?,?,?,?,0)
    ON CONFLICT(scope,key) DO UPDATE SET ids=excluded.ids,item_id=COALESCE(excluded.item_id,dropped_shows.item_id),dropped=excluded.dropped,updated=excluded.updated,source=excluded.source,confirmed=0
    WHERE excluded.updated>=dropped_shows.updated`)
    .bind(ev.scope, titleKey(ev.ids, 'series'), JSON.stringify(ev.ids), ev.itemId ?? null, ev.dropped ? 1 : 0, ev.at, ev.source ?? null);
}

export async function overlayDropped(ctx: Ctx, snapshot: WatchSnapshot): Promise<WatchSnapshot> {
  let dropped = [...snapshot.dropped ?? []];
  // Existing show dislikes from before drop support retain their local meaning.
  for (const [id, likes] of await itemRatings(ctx)) {
    const g = decodeGuid(id);
    if (likes || !g || !['series', 'season', 'episode'].includes(g.kind) || g.kind === 'view' || g.kind === 'misc') continue;
    const ids: IdBundle = g.source === 'imdb' ? { imdb: `tt${String(g.num).padStart(7, '0')}` } : { [g.source]: g.num };
    if (!dropped.some(other => sameShow(ids, other))) dropped.push(ids);
  }
  for (const row of await rows(ctx)) {
    const ids = JSON.parse(row.ids) as IdBundle;
    const matches = dropped.filter(other => sameShow(ids, other));
    dropped = dropped.filter(other => !sameShow(ids, other));
    if (row.dropped) dropped.push(Object.assign({}, ...matches, ids));
  }
  return { ...snapshot, dropped };
}

// Only a fresh, complete primary import can acknowledge an intent or reflect a later external change.
// Until the tracker confirms our write, local intent wins over stale imports and failed deliveries.
export async function reconcileDropped(ctx: Ctx, source: TrackerName, snapshot: WatchSnapshot): Promise<void> {
  if (!ctx.env.DB || !snapshot.dropped) return;
  const fetched = Date.parse(snapshot.fetchedAt);
  for (const row of await rows(ctx)) {
    if (row.source !== source || fetched < row.updated) continue;
    const ids = JSON.parse(row.ids) as IdBundle;
    const remote = snapshot.dropped.some(other => sameShow(ids, other));
    if (!row.confirmed && remote !== Boolean(row.dropped)) continue;
    await ctx.env.DB.prepare(`UPDATE dropped_shows SET dropped=?,confirmed=1 WHERE scope=? AND key=? AND updated=?
      AND NOT EXISTS (SELECT 1 FROM deliveries WHERE scope=? AND service=? AND operation='drop' AND status IN ('pending','failed')
        AND json_extract(payload,'$.scope')=? AND json_extract(payload,'$.at')>=?
        AND EXISTS (SELECT 1 FROM json_each(json_extract(payload,'$.ids')) a JOIN json_each(?) b ON a.key=b.key AND a.value=b.value WHERE a.key<>'tmdbType'))`)
      .bind(remote ? 1 : 0, ctx.historyScope ?? ctx.scope, row.key, row.updated, ctx.scope, source, ctx.historyScope ?? ctx.scope, row.updated, row.ids).run();
  }
}

import type { Ctx } from '../context';
import { cacheDelete, cacheGet, cachePut } from '../util/cache';
import { mapLimit } from '../util/concurrency';
import { clampPercent, epoch, nowIso, titleKey } from './common';
import type { ResumeEntry, ScrobbleAction, ScrobbleEvent } from './types';

const WATCHED_AT = 80;
const RECORD_TTL_S = 24 * 3600;
const INDEX_MAX = 60;

export interface BufferRecord {
  action: ScrobbleAction;
  progress: number;
  at: string;
  ev: Pick<ScrobbleEvent, 'ids' | 'kind' | 'season' | 'episode'>;
}

interface IndexBlob { keys: string[] }

function recordKey(ctx: Ctx, key: string): string {
  return `scrobble:${ctx.scope}:${key}`;
}
function indexKey(ctx: Ctx): string {
  return `scrobble-index:${ctx.scope}`;
}

export async function recordConfirmed(ctx: Ctx, ev: ScrobbleEvent): Promise<void> {
  const key = titleKey(ev.ids, ev.kind, ev.season, ev.episode);
  const next: BufferRecord = {
    action: ev.action, progress: clampPercent(ev.progress), at: nowIso(),
    ev: { ids: ev.ids, kind: ev.kind, season: ev.season, episode: ev.episode },
  };
  await cachePut(recordKey(ctx, key), next, RECORD_TTL_S);
  await touchIndex(ctx, key);
}

async function touchIndex(ctx: Ctx, key: string): Promise<void> {
  const blob = (await cacheGet<IndexBlob>(indexKey(ctx))) ?? { keys: [] };
  const keys = [key, ...blob.keys.filter((k) => k !== key)].slice(0, INDEX_MAX);
  await cachePut(indexKey(ctx), { keys }, RECORD_TTL_S);
}

export async function bufferedRecords(ctx: Ctx): Promise<BufferRecord[]> {
  const blob = await cacheGet<IndexBlob>(indexKey(ctx));
  if (!blob?.keys?.length) return [];
  const rows = await mapLimit(blob.keys, 8, (k) => cacheGet<BufferRecord>(recordKey(ctx, k)));
  return rows.filter((r): r is BufferRecord => !!r && !!r.ev).sort((a, b) => epoch(b.at) - epoch(a.at));
}

export async function bufferedResume(ctx: Ctx): Promise<ResumeEntry[]> {
  const out: ResumeEntry[] = [];
  for (const r of await bufferedRecords(ctx)) {
    if (r.progress <= 0 || finishedInBuffer(r)) continue;
    out.push({ ids: r.ev.ids, kind: r.ev.kind, season: r.ev.season, episode: r.ev.episode, progress: r.progress, at: r.at });
  }
  return out;
}

export function finishedInBuffer(r: BufferRecord): boolean {
  return r.action === 'stop' && r.progress >= WATCHED_AT;
}

export async function forgetTitle(ctx: Ctx, ev: Pick<ScrobbleEvent, 'ids' | 'kind' | 'season' | 'episode'>): Promise<void> {
  await cacheDelete(recordKey(ctx, titleKey(ev.ids, ev.kind, ev.season, ev.episode)), ctx.origin, ctx.env.DB);
}

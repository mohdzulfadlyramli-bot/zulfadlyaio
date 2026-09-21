import { importedHistory } from '../storage/imported-history';
import type { Ctx } from '../context';
import type { TrackerName } from '../config/schema';
import { cacheDelete, cacheGet, cachePut } from '../util/cache';
import { anilistTracker } from './anilist';
import { emptySnapshot, epoch, resumeKey, titleKey } from './common';
import { recordConfirmed, bufferedRecords, finishedInBuffer, forgetTitle } from './debounce';
import { malTracker } from './mal';
import { simklTracker } from './simkl';
import { mdblistTracker } from './mdblist';
import { publicmetadbTracker } from './publicmetadb';
import { trackerTargets } from './targets';
import { traktTracker } from './trakt';
import { enqueue, drain } from '../storage/deliveries';
import { overlayHistory } from '../storage/history';
import type { DropEvent, MarkEvent, ResumeEntry, ScrobbleEvent, Tracker, TrackerApi, WatchSnapshot } from './types';
import type { IdBundle } from '../meta/types';
import { localDrop, overlayDropped, sameShow } from '../storage/dropped';
import { withStateLock } from '../storage/lock';

const REGISTRY: Record<TrackerName, Tracker> = {
  mdblist: mdblistTracker,
  publicmetadb: publicmetadbTracker,
  trakt: traktTracker,
  simkl: simklTracker,
  mal: malTracker,
  anilist: anilistTracker,
};

export { mdblistTracker, publicmetadbTracker, traktTracker, simklTracker, malTracker, anilistTracker };
export { bufferedResume } from './debounce';

function byName(name: TrackerName | 'off' | undefined): Tracker | null {
  if (!name || name === 'off') return null;
  return REGISTRY[name] ?? null;
}

function snapshotKey(ctx: Ctx, tracker: Tracker): string {
  return `tracker-snapshot:${ctx.scope}:${ctx.cacheRevision ?? ctx.cfgToken}:${tracker.name}`;
}

function primary(ctx: Ctx): Tracker | null {
  if (ctx.profile && !ctx.profile.sharesHistory) return null;
  const t = byName(ctx.cfg.trackers.primary);
  return t && t.ready(ctx) ? t : null;
}

function sinks(ctx: Ctx): Tracker[] {
  if (ctx.profile && !ctx.profile.sharesHistory) return [];
  const out: Tracker[] = [];
  const seen = new Set<TrackerName>();
  const wanted: Array<TrackerName | 'off' | undefined> = [ctx.cfg.trackers.primary, ...ctx.cfg.trackers.scrobbleTo];
  for (const name of wanted) {
    const t = byName(name);
    if (!t || seen.has(t.name) || !t.ready(ctx)) continue;
    seen.add(t.name);
    out.push(t);
  }
  return out;
}

async function overlayBuffer(ctx: Ctx, base: ResumeEntry[]): Promise<ResumeEntry[]> {
  const records = await bufferedRecords(ctx);
  if (!records.length) return base;
  const merged = new Map<string, ResumeEntry>();
  for (const e of base) merged.set(resumeKey(e), e);
  for (const r of records) {
    const key = titleKey(r.ev.ids, r.ev.kind, r.ev.season, r.ev.episode);
    const existing = merged.get(key);
    if (existing && epoch(existing.at) >= epoch(r.at)) continue;
    if (finishedInBuffer(r)) { merged.delete(key); continue; }
    if (r.progress <= 0) continue;
    merged.set(key, { ids: r.ev.ids, kind: r.ev.kind, season: r.ev.season, episode: r.ev.episode, progress: r.progress, at: r.at, ref: existing?.ref });
  }
  return [...merged.values()].sort((a, b) => epoch(b.at) - epoch(a.at));
}

async function snapshot(ctx: Ctx): Promise<WatchSnapshot> {
  const t = primary(ctx);
  if (!t) return overlayHistory(ctx, await overlayDropped(ctx, emptySnapshot()));
  const base = await importedHistory(ctx, t, snapshotKey(ctx, t));
  const resume = await overlayBuffer(ctx,base.resume);
  return overlayHistory(ctx, await overlayDropped(ctx,{...base,resume}));
}

const restoreSnapshots = new WeakMap<Ctx, Promise<WatchSnapshot>>();
export async function restoreDroppedShow(ctx: Ctx, ids: IdBundle): Promise<void> {
  let task = restoreSnapshots.get(ctx);
  if (!task) { task = snapshot(ctx); restoreSnapshots.set(ctx, task); }
  const state = await task;
  const dropped = state.dropped?.find(other => sameShow(ids, other));
  if (!dropped) return;
  await drop(ctx, { ...dropped, ...ids }, false);
  state.dropped = state.dropped?.filter(other => !sameShow(ids, other));
}

async function drop(ctx: Ctx, ids: IdBundle, dropped: boolean, itemId?: string, rating?: DropEvent['rating']): Promise<void> {
  if (!ctx.env.DB) throw new Error('Durable storage is required to drop shows');
  await withStateLock(ctx, `drop:${ctx.historyScope ?? ctx.scope}`, async () => {
    const previous = await localDrop(ctx, ids);
    const targets = sinks(ctx).filter(t => t.drop && ctx.cfg.trackers.media?.[t.name]?.series !== false);
    const source = primary(ctx)?.name;
    const event: DropEvent = { ids: { ...previous?.bundle, ...ids }, dropped, itemId: itemId ?? previous?.item_id ?? undefined,
      scope: ctx.historyScope ?? ctx.scope, at: Math.max(Date.now(), (previous?.updated ?? 0) + 1),
      source: targets.some(t => t.name === source) ? source : undefined, rating };
    await enqueue(ctx, 'drop', event, targets);
  });
  restoreSnapshots.delete(ctx);
  await invalidate(ctx);
  if (!ctx.queueOnly) { if (ctx.defer) ctx.defer(drain(ctx, REGISTRY)); else await drain(ctx, REGISTRY); }
}

async function invalidate(ctx: Ctx): Promise<void> {
  const t = primary(ctx);
  if (t) await cacheDelete(snapshotKey(ctx, t), ctx.origin, ctx.env.DB);
}

async function scrobble(ctx: Ctx, ev: ScrobbleEvent): Promise<void> {
  if (ev.kind === 'episode' && ev.action === 'start' && ctx.env.DB) await restoreDroppedShow(ctx, ev.ids);
  const targets = sinks(ctx).filter(t => ctx.cfg.trackers.media?.[t.name]?.[ev.kind === 'movie' ? 'movie' : 'series'] !== false);
  if (ctx.env.DB) {
    await enqueue(ctx,'scrobble',ev,targets);
    if (!ctx.queueOnly) { if (ctx.defer) ctx.defer(drain(ctx,REGISTRY)); else await drain(ctx,REGISTRY); }
    await invalidate(ctx);
    return;
  }
  if (!targets.length) return;
  const results = await Promise.allSettled(targets.map(async (t) => {
    const ack = ev.deliveryId ? `scrobble-ack:${ctx.scope}:${t.name}:${ev.deliveryId}` : null;
    if (ack && await cacheGet<boolean>(ack)) return;
    const events = await trackerTargets(ctx, ev, t.name);
    for (let i = 0; i < events.length; i++) {
      const part = ack ? `${ack}:part:${i}` : null;
      if (part && await cacheGet<boolean>(part)) continue;
      await t.scrobble(ctx, events[i]);
      if (part) await cachePut(part, true, 6 * 3600);
    }
    if (ack) await cachePut(ack, true, 6 * 3600);
  }));
  const failed = results.flatMap((r, i) => r.status === 'rejected' ? [targets[i].name] : []);
  if (failed.length) {
    throw new Error(`Scrobble delivery failed: ${failed.join(', ')}`);
  }
  await recordConfirmed(ctx, ev);
  if (ev.action === 'stop') await invalidate(ctx);
}

async function mark(ctx: Ctx, ev: MarkEvent): Promise<void> {
  if (ev.kind !== 'movie' && ev.watched && ctx.env.DB) await restoreDroppedShow(ctx, ev.ids);
  const targets = sinks(ctx).filter(t => ctx.cfg.trackers.media?.[t.name]?.[ev.kind === 'movie' ? 'movie' : 'series'] !== false);
  if (ctx.env.DB) {
    await enqueue(ctx,'mark',ev,targets);
    if (!ctx.queueOnly) { if (ctx.defer) ctx.defer(drain(ctx,REGISTRY)); else await drain(ctx,REGISTRY); }
    await invalidate(ctx);
    return;
  }
  const results = await Promise.allSettled(targets.map(async (t) => {
    for (const event of await trackerTargets(ctx, ev, t.name)) await t.mark(ctx, event);
  }));
  const failed = results.flatMap((r, i) => r.status === 'rejected' ? [targets[i].name] : []);
  if (failed.length) throw new Error(`Watch update failed: ${failed.join(', ')}`);
  if (ev.kind !== 'series') await forgetTitle(ctx, { ids: ev.ids, kind: ev.kind, season: ev.season, episode: ev.episode });
  await invalidate(ctx);
}

async function clearResume(ctx: Ctx, entry: ResumeEntry): Promise<void> {
  const t = primary(ctx);
  if (ctx.env.DB) {
    await enqueue(ctx,'clear',entry,t ? [t] : []);
    if (!ctx.queueOnly) { if (ctx.defer) ctx.defer(drain(ctx,REGISTRY)); else await drain(ctx,REGISTRY); }
    await forgetTitle(ctx,entry);
    await invalidate(ctx);
    return;
  }
  if (t?.clearResume) await t.clearResume(ctx, entry);
  await forgetTitle(ctx, entry);
  await invalidate(ctx);
}

export const trackerApi: TrackerApi = {
  primary,
  sinks,
  snapshot,
  scrobble,
  mark,
  clearResume,
  drop,
  invalidate,
};

export async function drainTracking(ctx: Ctx,limit=2): Promise<void> { await drain(ctx,REGISTRY,limit); }

export function catalogTrackers(ctx: Ctx): Tracker[] {
  if (ctx.profile && !ctx.profile.sharesHistory) return [];
  return Object.values(REGISTRY).filter(t => t.ready(ctx));
}

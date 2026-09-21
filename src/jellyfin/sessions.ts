import { queueBulk } from '../storage/bulk';
import { mapLimit } from '../util/concurrency';
import { metaApi } from '../meta/index';
import type { IdBundle } from '../meta/types';
import { trackerApi } from '../trackers/index';
import type { MarkEvent, ScrobbleEvent } from '../trackers/types';
import { stateGet, statePut } from '../storage/state';
import { saveHistory } from '../storage/history';
import { runtimeTicks, ticksToMs, userData, type Dto } from './dto';
import { decodeGuid, plainGuid, type TitleGuid } from './ids';
import { bundleOf, type Library } from './library';
import { collectionMembers } from '../addon/collections';
import { parseStremioId } from '../stremio/ids';

const POSITION_TTL = 6 * 60 * 60;
const RETRY_DELAY_MS = 30_000;
const MAX_ATTEMPTS = 2;

interface PlayCursor {
  at?: string;
  positionMs: number;
  paused: boolean;
  stopped?: boolean;
  target?: PlayTarget;
  sequence: number;
  generation: string;
  pending?: ScrobbleEvent['action'];
  attempts?: number;
  retryAt?: number;
}

export function cursorKey(lib: Library, r: PlayReport): string {
  return `jf:play:v2:${lib.ctx.historyScope ?? lib.ctx.scope}:${lib.jf.client.deviceId}:${r.itemId}:${r.playSessionId || 'legacy'}`;
}

export interface PlayTarget {
  numbering?: ScrobbleEvent['numbering'];
  animeEpisode?: ScrobbleEvent['animeEpisode'];
  guid: TitleGuid;
  ids: IdBundle;
  kind: 'movie' | 'episode';
  season?: number;
  episode?: number;
  runtimeMs?: number;
}

function numberingOf(lib: Library, g: TitleGuid): ScrobbleEvent['numbering'] {
  if (['mal', 'anilist', 'kitsu', 'anidb'].includes(g.source)) return 'anime';
  if (g.source === 'tvdb') return 'tvdb';
  if (g.source === 'tmdb') return 'tmdb';
  return lib.ctx.cfg.providers.series === 'tvdb' ? 'tvdb' : 'tmdb';
}

export async function playTarget(lib: Library, itemId: string): Promise<PlayTarget | null> {
  const g = decodeGuid(itemId);
  if (!g || (g.kind !== 'movie' && g.kind !== 'episode')) return null;
  const meta = await lib.meta(g);
  let ids = bundleOf(g, meta);
  if (!ids.imdb || !ids.tmdb || !ids.tvdb) {
    try {
      ids = { ...ids, ...(await metaApi.resolveIds(lib.ctx, lib.streamIdOf(null, g.kind === 'movie' ? g : { ...g, kind: 'series' }), g.kind === 'movie' ? 'movie' : 'series')) };
    } catch {
    }
  }
  const episode = g.kind === 'episode' ? meta?.videos?.find(v => v.season === (g.season ?? 1) && v.episode === g.episode) : undefined;
  if (g.kind === 'episode' && !['mal', 'anilist', 'kitsu', 'anidb'].includes(g.source)) {
    delete ids.mal; delete ids.anilist; delete ids.kitsu; delete ids.anidb;
  }
  const rt = runtimeTicks((episode as { runtime?: string } | undefined)?.runtime ?? meta?.runtime);
  const target: PlayTarget = { numbering: episode?.numbering ?? numberingOf(lib, g), animeEpisode: episode?.trackerAnime, guid: g, ids, kind: g.kind, runtimeMs: rt ? rt / 10_000 : undefined };
  if (g.kind === 'episode') {
    target.season = g.season ?? 1;
    target.episode = g.episode;
  }
  return target;
}

function progressOf(positionMs: number, runtimeMs: number | undefined): number {
  if (!runtimeMs || runtimeMs <= 0 || positionMs <= 0) return 0;
  return Math.max(0, Math.min(100, (positionMs / runtimeMs) * 100));
}

export interface PlayReport {
  at?: string;
  itemId: string;
  positionTicks?: unknown;
  runtimeTicks?: unknown;
  isPaused?: boolean;
  playSessionId?: string;
}

export function reportOf(body: Record<string, unknown>, paramId?: string): PlayReport | null {
  const item = (body.Item ?? body.item) as Record<string, unknown> | undefined;
  const itemId = plainGuid(body.ItemId ?? body.itemId ?? item?.Id ?? paramId);
  if (!itemId) return null;
  const paused = body.IsPaused ?? body.isPaused;
  const session = body.PlaySessionId ?? body.playSessionId;
  return {
    itemId,
    positionTicks: body.PositionTicks ?? body.positionTicks,
    runtimeTicks: body.RunTimeTicks ?? body.runTimeTicks ?? item?.RunTimeTicks,
    isPaused: typeof paused === 'boolean' ? paused : undefined,
    playSessionId: typeof session === 'string' ? session.slice(0, 128) : undefined,
  };
}

async function transition(lib: Library, r: PlayReport, known: PlayCursor | null, action: ScrobbleEvent['action']): Promise<void> {
  const retry = known?.pending === action;
  if (!lib.ctx.env.DB && retry && ((known.attempts ?? 0) >= MAX_ATTEMPTS || Date.now() < (known.retryAt ?? 0))) return;
  const key = cursorKey(lib, r);
  const target = action==='start' && known?.stopped && !retry ? await playTarget(lib,r.itemId) : known?.target ?? await playTarget(lib, r.itemId);
  if (!target) return;
  const clientRuntime = ticksToMs(r.runtimeTicks);
  const t = { ...target, runtimeMs: clientRuntime && clientRuntime > 0 ? clientRuntime : target.runtimeMs };
  const positionMs = retry ? known.positionMs : ticksToMs(r.positionTicks) ?? known?.positionMs ?? 0;
  const sequence = retry ? known.sequence : (known?.sequence ?? 0) + 1;
  const next: PlayCursor = {
    at: retry ? known.at : r.at,
    positionMs, paused: action === 'pause', stopped: action === 'stop', target: t,
    sequence, generation: known?.generation ?? crypto.randomUUID(), pending: action, attempts: retry ? (known.attempts ?? 0) + 1 : 1,
    retryAt: Date.now() + RETRY_DELAY_MS,
  };
  await statePut(lib.ctx, key, next, POSITION_TTL);
  const ev: ScrobbleEvent = {
    at: next.at,
    action, numbering: t.numbering, animeEpisode: t.animeEpisode, ids: t.ids, kind: t.kind, season: t.season, episode: t.episode,
    progress: progressOf(positionMs, t.runtimeMs), positionMs, runtimeMs: t.runtimeMs,
    deliveryId: `${key}:${next.generation}:${sequence}:${action}`,
  };
  await trackerApi.scrobble(lib.ctx, ev);
  await statePut(lib.ctx, key, { ...next, pending: undefined, retryAt: undefined }, POSITION_TTL);
}

async function onPlayingUnlocked(lib: Library, r: PlayReport): Promise<void> {
  if (!lib.ctx.env.DB && !trackerApi.sinks(lib.ctx).length) return;
  const known = await stateGet<PlayCursor>(lib.ctx, cursorKey(lib, r));
  if (known && known.sequence > 0 && !known.paused && !known.stopped && !known.pending) {
    await checkpoint(lib, r, known);
    return;
  }
  await transition(lib, r, known, r.isPaused ? 'pause' : 'start');
}

async function checkpoint(lib: Library, r: PlayReport, known: PlayCursor | null): Promise<void> {
  if (known?.pending) return;
  const positionMs = ticksToMs(r.positionTicks);
  if (positionMs === null) return;
  if (known && known.positionMs === positionMs) return;
  if (known?.target) await saveHistory(lib.ctx, { ...known.target, at: r.at, positionMs, action:'start', progress:progressOf(positionMs, known.target.runtimeMs) }, 'progress');
  await statePut(lib.ctx, cursorKey(lib, r), {
    ...known, positionMs, paused: r.isPaused ?? known?.paused ?? false,
    sequence: known?.sequence ?? 0, generation: known?.generation ?? crypto.randomUUID(),
  }, POSITION_TTL);
}

async function onProgressUnlocked(lib: Library, r: PlayReport): Promise<void> {
  if (!lib.ctx.env.DB && !trackerApi.sinks(lib.ctx).length) return;
  const known = await stateGet<PlayCursor>(lib.ctx, cursorKey(lib, r));
  if (known?.stopped) return;
  if (r.isPaused === undefined || (!known && !r.isPaused) || (known && known.paused === r.isPaused && !known.pending)) {
    await checkpoint(lib, r, known);
    return;
  }
  await transition(lib, r, known, r.isPaused ? 'pause' : 'start');
}

async function onStoppedUnlocked(lib: Library, r: PlayReport): Promise<void> {
  if (!lib.ctx.env.DB && !trackerApi.sinks(lib.ctx).length) return;
  const known = await stateGet<PlayCursor>(lib.ctx, cursorKey(lib, r));
  if (known?.stopped && !known.pending) return;
  await transition(lib, r, known, 'stop');
}

export async function setPlayed(lib: Library, itemId: string, watched: boolean): Promise<Dto> {
  const id = plainGuid(itemId);
  const g = decodeGuid(id);
  const state = userData(id, { played: watched, lastPlayed: watched ? new Date().toISOString() : undefined });
  if (!g || g.kind === 'view' || g.kind === 'misc') return state;
  if (g.source === 'tvdbc' || g.source === 'tmdbc') {
    const members = await collectionMembers(lib.ctx, `${g.source}:${g.num}`, 0, 1000);
    if (members.total > 1000) throw new Error('Collection is too large to mark in one action');
    const events: MarkEvent[] = [];
    for (const item of members.items) {
      const parsed = parseStremioId(item.id);
      if (parsed.source==='other'||parsed.source==='tmdbc'||parsed.source==='tvdbc') throw new Error('Collection contains an unrecognized movie ID');
      const meta = await metaApi.resolveMeta(lib.ctx, 'movie', item.id);
      if (meta?.released && Date.parse(meta.released) > Date.now()) continue;
      const ids = meta?.ids;
      if (!ids || !Object.values(ids).some(Boolean)) throw new Error('Collection movie IDs are unavailable');
      events.push({ids, kind:'movie', watched});
    }
    if (lib.ctx.env.DB) await queueBulk(lib.ctx, events);
    else await mapLimit(events, 1, event => trackerApi.mark(lib.ctx, event));
    await trackerApi.invalidate(lib.ctx);
    return state;
  }
  const meta = await lib.meta(g);
  const ids = bundleOf(g, meta);
  if (g.kind !== 'movie' && !['mal', 'anilist', 'kitsu', 'anidb'].includes(g.source)) {
    delete ids.mal; delete ids.anilist; delete ids.kitsu; delete ids.anidb;
  }
  const ev: MarkEvent = { ids, numbering: numberingOf(lib, g), kind: g.kind === 'movie' ? 'movie' : g.kind === 'episode' ? 'episode' : 'series', watched };
  if (g.kind === 'episode') {
    ev.season = g.season ?? 1;
    ev.episode = g.episode;
    const video = meta?.videos?.find(v => v.season === ev.season && v.episode === ev.episode);
    ev.animeEpisode = video?.trackerAnime;
    ev.numbering = video?.numbering ?? ev.numbering;
  } else if (g.kind === 'season') {
    ev.season = g.season;
  }
  try {
    if (g.kind === 'season' || g.kind === 'series') {
      const now = Date.now();
      const videos = (meta?.videos ?? []).filter(v =>
        v.episode !== undefined && v.season !== undefined &&
        (g.kind === 'season' ? v.season === g.season : v.season > 0) &&
        (!v.released || !Number.isFinite(Date.parse(v.released)) || Date.parse(v.released) <= now));
      if (lib.ctx.env.DB && videos.length > 10) {
        await queueBulk(lib.ctx,videos.map(v => ({...ev,numbering:v.numbering ?? ev.numbering,animeEpisode:v.trackerAnime,kind:'episode',season:v.season,episode:v.episode})));
        return state;
      }
      await mapLimit(videos, 1, async v => {
        await trackerApi.mark(lib.ctx, { ...ev, numbering: v.numbering ?? ev.numbering, animeEpisode: v.trackerAnime, kind: 'episode', season: v.season, episode: v.episode });
      });
    } else {
      await trackerApi.mark(lib.ctx, ev);
    }
    if (!watched && (g.kind === 'movie' || g.kind === 'episode')) await dropResume(lib, g);
  } finally {
    await trackerApi.invalidate(lib.ctx).catch(() => undefined);
  }
  return state;
}

export async function dropResume(lib: Library, g: TitleGuid): Promise<void> {
  const idx = await lib.watch();
  const keys = lib.keysOf(plainGuid(''), g);
  const entry = g.kind === 'movie' ? idx.movie(keys).resume : idx.episode(keys, g.season ?? 1, g.episode ?? 0).resume;
  if (!entry) return;
  await trackerApi.clearResume(lib.ctx, entry);
}

export async function updateUserData(lib: Library, itemId: string, body: Record<string, unknown>): Promise<Dto> {
  const id = plainGuid(itemId);
  const g = decodeGuid(id);
  const played = body.Played ?? body.played;
  const positionTicks = ticksToMs(body.PlaybackPositionTicks ?? body.playbackPositionTicks);
  if (typeof played === 'boolean') return setPlayed(lib, id, played);
  if (g && (g.kind === 'movie' || g.kind === 'episode') && positionTicks === 0) {
    await dropResume(lib, g);
    await trackerApi.invalidate(lib.ctx).catch(() => undefined);
  }
  return userData(id, { positionTicks: positionTicks !== null ? positionTicks * 10_000 : 0 });
}

// Durable report consumers hold the session lock while applying reports.
export async function applyPlaybackReport(lib: Library, r: PlayReport, action: 'start' | 'progress' | 'stop'): Promise<void> {
  if (action === 'start') return onPlayingUnlocked(lib, r);
  if (action === 'stop') return onStoppedUnlocked(lib, r);
  return onProgressUnlocked(lib, r);
}

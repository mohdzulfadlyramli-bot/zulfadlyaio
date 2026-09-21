import type { Ctx } from '../context';
import type { SimklAuth } from '../config/schema';
import type { IdBundle } from '../meta/types';
import type { ManifestCatalog, MetaPreview } from '../stremio/types';
import { cacheDelete, fetchJson,memo } from '../util/cache';
import { clampPercent, emptySnapshot, epoch, fingerprint, isoOrNow, nowIso, sendRequest, stremioIdOf } from './common';
import type { DropEvent, MarkEvent, ScrobbleEvent, Tracker, WatchSnapshot } from './types';
import { sameShow } from '../storage/dropped';

const API = 'https://api.simkl.com';

type SimklKind = 'movies' | 'tv' | 'anime';
type Status = 'watching' | 'completed' | 'plantowatch' | 'hold' | 'dropped';

interface SimklIds { simkl?: number; imdb?: string; tmdb?: string | number; tvdb?: string | number; mal?: string | number; anilist?: string | number; kitsu?: string | number; anidb?: string | number }
interface SimklTitle { title?: string; year?: number; poster?: string; ids?: SimklIds; overview?: string; genres?: string[]; anime_type?: string }
interface SimklEpisode { number: number; season?: number; watched_at?: string }
interface LibraryItem {
  user_rating?:number;
  next_to_watch?:string;
  last_watched_at?: string;
  status?: Status;
  watched_episodes_count?: number;
  total_episodes_count?: number;
  movie?: SimklTitle;
  show?: SimklTitle;
  seasons?: Array<{ number: number; episodes?: SimklEpisode[] }>;
  episodes?: SimklEpisode[];
}
interface LibraryPayload { movies?: LibraryItem[]; shows?: LibraryItem[]; anime?: LibraryItem[] }
interface PlaybackItem {
  progress?: number;
  paused_at?: string;
  type?: 'movie' | 'episode';
  movie?: SimklTitle;
  show?: SimklTitle;
  anime?: SimklTitle;
  episode?: { season?: number; number?: number; tvdb_season?: number; tvdb_number?: number };
}

function auth(ctx: Ctx): SimklAuth | undefined {
  const a = ctx.cfg.trackers.simkl;
  return a && a.clientId && a.accessToken ? a : undefined;
}

function headers(a: SimklAuth): Record<string, string> {
  return { 'content-type': 'application/json', 'simkl-api-key': a.clientId, authorization: `Bearer ${a.accessToken}` };
}

async function get<T>(ctx: Ctx, a: SimklAuth, path: string, ttl: number): Promise<T | null> {
  const result = await fetchJson<T>(`${API}${path}`, { headers: headers(a), ttl, cacheScope: `simkl:${ctx.scope}:${await fingerprint(a.accessToken)}` });
  if (ctx.env.DB && result === null) throw new Error('simkl read unavailable');
  return result;
}

async function post(a: SimklAuth, path: string, payload: unknown): Promise<boolean> {
  const res = await sendRequest(`${API}${path}`, { method: 'POST', headers: headers(a), body: JSON.stringify(payload) });
  return res.ok || (path === '/scrobble/stop' && res.status === 409);
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function bundleOf(ids: SimklIds | undefined, tmdbType?: 'movie' | 'tv'): IdBundle {
  const out: IdBundle = {};
  if (!ids) return out;
  if (ids.imdb) out.imdb = String(ids.imdb);
  const tmdb = num(ids.tmdb); if (tmdb) { out.tmdb = tmdb; if (tmdbType) out.tmdbType = tmdbType; }
  const tvdb = num(ids.tvdb); if (tvdb) out.tvdb = tvdb;
  const mal = num(ids.mal); if (mal) out.mal = mal;
  const anilist = num(ids.anilist); if (anilist) out.anilist = anilist;
  const kitsu = num(ids.kitsu); if (kitsu) out.kitsu = kitsu;
  const anidb = num(ids.anidb); if (anidb) out.anidb = anidb;
  return out;
}

function idsForWrite(ids: IdBundle): Record<string, string | number> | null {
  const out: Record<string, string | number> = {};
  if (ids.imdb) out.imdb = ids.imdb;
  if (ids.tmdb) out.tmdb = ids.tmdb;
  if (ids.tvdb) out.tvdb = ids.tvdb;
  if (ids.mal) out.mal = ids.mal;
  if (ids.anilist) out.anilist = ids.anilist;
  if (ids.kitsu) out.kitsu = ids.kitsu;
  if (ids.anidb) out.anidb = ids.anidb;
  return Object.keys(out).length ? out : null;
}

function posterOf(t: SimklTitle | undefined): string | undefined {
  return t?.poster ? `https://simkl.in/posters/${t.poster}_m.jpg` : undefined;
}

function rowsOf(payload: LibraryPayload | LibraryItem[] | null, kind: SimklKind): LibraryItem[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  const list = kind === 'movies' ? payload.movies : kind === 'tv' ? payload.shows : payload.anime;
  return Array.isArray(list) ? list : [];
}

const activityRequests=new WeakMap<Ctx,Promise<string>>();
const listRequests=new WeakMap<Ctx,Map<Status,Promise<LibraryPayload>>>();
function activity(ctx:Ctx,a:SimklAuth):Promise<string> {
  let task=activityRequests.get(ctx);
  if(!task){task=get<Record<string,unknown>>(ctx,a,'/sync/activities',60).then(data=>{if(!data)throw new Error('Simkl activity check unavailable');return fingerprint(JSON.stringify(data));});activityRequests.set(ctx,task);}
  return task;
}
async function statusRows(ctx:Ctx,a:SimklAuth,status:Status):Promise<LibraryPayload> {
  let tasks=listRequests.get(ctx);if(!tasks){tasks=new Map();listRequests.set(ctx,tasks);}
  let task=tasks.get(status);
  if(!task){task=(async()=>{
    const changed=await activity(ctx,a),key=`simkl:status:v2:${ctx.scope}:${await fingerprint(a.accessToken)}:${status}:${changed}`;
    return memo(key,86400,async()=>{
      const data=await get<LibraryPayload>(ctx,a,`/sync/all-items/${status}?extended=full&episode_watched_at=yes&next_watch_info=yes`,0);
      if(!data)throw new Error('Simkl library unavailable');return data;
    });
  })();tasks.set(status,task);}
  return task;
}
async function library(ctx: Ctx, a: SimklAuth, kind: SimklKind, status: Status, _extended: boolean): Promise<LibraryItem[]> {
  return rowsOf(await statusRows(ctx,a,status),kind);
}

export interface ViewingSignal {ids:IdBundle;kind:'movie'|'series';anime:boolean;title?:string;year?:number;at:string;state:string;rating?:number}
export async function simklSignals(ctx:Ctx):Promise<ViewingSignal[]> {
  const a=auth(ctx);if(!a||ctx.profile&&!ctx.profile.sharesHistory)return [];
  const statuses:Status[]=['completed','watching','hold','dropped','plantowatch'];
  return (await Promise.all(statuses.map(async status=>{
    const data=await statusRows(ctx,a,status);
    return (['movies','shows','anime'] as const).flatMap(bucket=>(data[bucket]??[]).flatMap(row=>{
      const title=row.movie??row.show;if(!title)return [];
      return [{ids:bundleOf(title.ids,bucket==='movies'?'movie':'tv'),kind:bucket==='movies'?'movie' as const:'series' as const,anime:bucket==='anime',title:title.title,year:title.year,at:row.last_watched_at??'',state:row.status??status,rating:row.user_rating}];
    }));
  }))).flat();
}

async function snapshot(ctx: Ctx): Promise<WatchSnapshot> {
  const a = auth(ctx);
  if (!a) return emptySnapshot();

  const [moviesDone, tvWatching, tvDone, animeWatching, animeDone, playback, dropped, held] = await Promise.all([
    library(ctx, a, 'movies', 'completed', false),
    library(ctx, a, 'tv', 'watching', true),
    library(ctx, a, 'tv', 'completed', true),
    library(ctx, a, 'anime', 'watching', true),
    library(ctx, a, 'anime', 'completed', true),
    get<PlaybackItem[]>(ctx, a, '/sync/playback', 30),
    statusRows(ctx, a, 'dropped'),
    statusRows(ctx, a, 'hold'),
  ]);

  const out = emptySnapshot();
  out.dropped = [...dropped.shows ?? [], ...dropped.anime ?? []].flatMap(row => row.show ? [bundleOf(row.show.ids, 'tv')] : []);

  for (const m of moviesDone) {
    if (!m.movie) continue;
    out.movies.push({ ids: bundleOf(m.movie.ids, 'movie'), plays: 1, lastAt: isoOrNow(m.last_watched_at) });
  }

  const addShow = (item: LibraryItem, anime: boolean) => {
    const ids = bundleOf(item.show?.ids, 'tv');
    let lastAt = isoOrNow(item.last_watched_at);
    let lastSeason: number | undefined;
    let lastEpisode: number | undefined;
    let best = 0;
    const push = (season: number, number: number, at?: string) => {
      const stamp = isoOrNow(at ?? item.last_watched_at);
      out.episodes.push({ ids, season, episode: number, plays: 1, lastAt: stamp });
      const t = epoch(at);
      if (t >= best) { best = t; lastSeason = season; lastEpisode = number; lastAt = stamp; }
    };
    for (const season of item.seasons ?? []) for (const ep of season.episodes ?? []) push(season.number, ep.number, ep.watched_at);
    for (const ep of item.episodes ?? []) push(ep.season ?? 1, ep.number, ep.watched_at);
    if (!item.seasons?.length && !item.episodes?.length && anime) {
      const count = Number(item.watched_episodes_count) || (item.status === 'completed' ? Number(item.total_episodes_count) : 0) || 0;
      for (let i = 1; i <= count; i++) out.episodes.push({ ids, season: 1, episode: i, plays: 1, lastAt });
      lastSeason = count ? 1 : undefined; lastEpisode = count || undefined;
    }
    out.shows.push({ ids, lastAt, lastSeason, lastEpisode });
  };

  for (const item of [...tvWatching, ...tvDone, ...dropped.shows ?? [], ...held.shows ?? []]) if (item.show) addShow(item, false);
  for (const item of [...animeWatching, ...animeDone, ...dropped.anime ?? [], ...held.anime ?? []]) if (item.show) addShow(item, true);

  for (const p of playback ?? []) {
    const progress = clampPercent(p.progress);
    if (progress <= 0) continue;
    const at = isoOrNow(p.paused_at);
    const title = p.anime ?? p.show ?? p.movie;
    if (!title) continue;
    if (p.type === 'movie' || (!p.episode && p.movie)) {
      out.resume.push({ ids: bundleOf(title.ids, 'movie'), kind: 'movie', progress, at });
      continue;
    }
    if (!p.episode) continue;
    const season = Number(p.episode.tvdb_season ?? p.episode.season ?? 1);
    const number = Number(p.episode.tvdb_number ?? p.episode.number);
    if (!Number.isFinite(number)) continue;
    out.resume.push({ ids: bundleOf(title.ids, 'tv'), kind: 'episode', season, episode: number, progress, at });
  }

  out.shows.sort((x, y) => epoch(y.lastAt) - epoch(x.lastAt));
  out.resume.sort((x, y) => epoch(y.at) - epoch(x.at));
  out.fetchedAt = nowIso();
  return out;
}

async function drop(ctx: Ctx, ev: DropEvent): Promise<void> {
  const a = auth(ctx), ids = idsForWrite(ev.ids);
  if (!a || !ids) throw new Error('Simkl show ID or credentials unavailable');
  let to: Status = 'dropped';
  if (!ev.dropped) {
    const data = await get<LibraryPayload>(ctx, a, '/sync/all-items/dropped?extended=full&episode_watched_at=yes&next_watch_info=yes', 0);
    if (!data) throw new Error('Simkl dropped list unavailable');
    const row = [...data.shows ?? [], ...data.anime ?? []].find(row => sameShow(bundleOf(row.show?.ids, 'tv'), ev.ids));
    if (!row) return;
    const watched = row.watched_episodes_count ?? 0, total = row.total_episodes_count ?? 0;
    to = total > 0 && watched >= total ? 'completed' : watched > 0 ? 'watching' : 'plantowatch';
  }
  const res = await sendRequest(`${API}/sync/add-to-list`, { method: 'POST', headers: headers(a), body: JSON.stringify({ shows: [{ ids, to }] }) });
  if (!res.ok || (res.body as { not_found?: { shows?: unknown[] } } | null)?.not_found?.shows?.length) throw new Error('Simkl drop update rejected');
  activityRequests.delete(ctx); listRequests.delete(ctx);
  await cacheDelete(`json:simkl:${ctx.scope}:${await fingerprint(a.accessToken)}:${API}/sync/activities`, ctx.origin, ctx.env.DB);
}

function historyBody(ids: IdBundle, kind: 'movie' | 'episode' | 'series', season?: number, episode?: number): unknown | null {
  const idsOut = idsForWrite(ids);
  if (!idsOut) return null;
  if (kind === 'movie') return { movies: [{ ids: idsOut }] };
  if (kind === 'series') return { shows: [{ ids: idsOut }] };
  if (episode === undefined) return null;
  const animeOnly = !ids.imdb && !ids.tmdb && !ids.tvdb;
  if (animeOnly || season === undefined) return { shows: [{ ids: idsOut, episodes: [{ number: episode }] }] };
  return { shows: [{ ids: idsOut, seasons: [{ number: season, episodes: [{ number: episode }] }] }] };
}

async function scrobble(ctx: Ctx, ev: ScrobbleEvent): Promise<void> {
  const a = auth(ctx);
  if (!a) return;
  const ids = idsForWrite(ev.ids);
  if (!ids) throw new Error('Simkl requires a supported title ID');
  const progress = clampPercent(ev.progress);
  if (ev.action !== 'start' && progress < 1) return;
  if (ev.kind === 'episode' && (!ev.episode || ev.season === undefined)) throw new Error('Simkl requires episode numbering');
  const body = ev.kind === 'movie'
    ? { progress, movie: { ids } }
    : { progress, show: { ids }, episode: { season: ev.season, number: ev.episode } };
  if (!(await post(a, `/scrobble/${ev.action}`, body))) throw new Error('Simkl scrobble rejected');
}

async function mark(ctx: Ctx, ev: MarkEvent): Promise<void> {
  const a = auth(ctx);
  if (!a) return;
  const body = historyBody(ev.ids, ev.kind, ev.season, ev.episode);
  if (!body || !(await post(a, ev.watched ? '/sync/history' : '/sync/history/remove', body))) throw new Error('Simkl history update rejected');
}

const PTW: Array<{ type: 'movie' | 'series' | 'anime'; kind: SimklKind; name: string }> = [
  { type: 'movie', kind: 'movies', name: 'Simkl Plan to Watch (Movies)' },
  { type: 'series', kind: 'tv', name: 'Simkl Plan to Watch (Shows)' },
  { type: 'anime', kind: 'anime', name: 'Simkl Plan to Watch (Anime)' },
];

async function catalogs(ctx: Ctx): Promise<ManifestCatalog[]> {
  if (!auth(ctx)) return [];
  return PTW.flatMap(c=>[{ type:c.type,id:`simkl:ptw:${c.type}`,name:c.name,extra:[{name:'skip'}]},...(['watching','completed','hold','dropped'] as Status[]).filter(status=>c.type!=='movie'||status!=='watching'&&status!=='hold').map(status=>({type:c.type,id:`simkl:${status}:${c.type}`,name:`Simkl ${status==='hold'?'On hold':status[0].toUpperCase()+status.slice(1)}`,extra:[{name:'skip'}]}))]);
}

async function catalogItems(ctx: Ctx, catalogId: string, skip: number): Promise<MetaPreview[]> {
  const a = auth(ctx);
  if (!a) return [];
  const parts=catalogId.split(':'),status:Status=parts[1]==='ptw'?'plantowatch':parts[1] as Status;
  if(!['plantowatch','watching','completed','hold','dropped'].includes(status))return [];
  const def = PTW.find((c) => c.type===parts[2]);
  if (!def) return [];
  const rows = await library(ctx, a, def.kind, status, false);
  const out: MetaPreview[] = [];
  for (const row of rows.slice(Math.max(0, skip), Math.max(0, skip) + 100)) {
    const title = row.movie ?? row.show;
    if (!title) continue;
    const ids = bundleOf(title.ids, def.type === 'movie' ? 'movie' : 'tv');
    const id = stremioIdOf(ids);
    if (!id) continue;
    out.push({ id, type: def.type, name: title.title ?? id, poster: posterOf(title), description: title.overview, genres: title.genres, year: title.year, releaseInfo: title.year ? String(title.year) : undefined });
  }
  return out;
}

export const simklTracker: Tracker = {
  name: 'simkl',
  ready: (ctx) => !!auth(ctx),
  snapshot,
  drop,
  scrobble,
  mark,
  catalogs,
  catalogItems,
};

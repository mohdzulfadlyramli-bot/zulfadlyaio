import { credentials } from '../storage/credentials';
import type { Ctx } from '../context';
import type { MalAuth } from '../config/schema';
import type { ManifestCatalog, MetaPreview } from '../stremio/types';
import { fetchJson } from '../util/cache';
import { clampPercent, emptySnapshot, fingerprint, isoOrNow, nowIso, sendRequest } from './common';
import type { DropEvent, MarkEvent, ScrobbleEvent, Tracker, WatchSnapshot } from './types';

const API = 'https://api.myanimelist.net/v2';
const WATCHED_AT = 90;
const PAGE = 100;

type MalStatus = 'watching' | 'completed' | 'on_hold' | 'dropped' | 'plan_to_watch';

interface ListStatus { status?: MalStatus; num_episodes_watched?: number; updated_at?: string }
interface MalNode { id: number; title?: string; main_picture?: { medium?: string; large?: string }; num_episodes?: number; start_date?: string; synopsis?: string; genres?: Array<{ name: string }> }
interface ListRow { node: MalNode; list_status?: ListStatus }
interface ListPage { data?: ListRow[]; paging?: { next?: string } }
interface AnimeDetail { id: number; num_episodes?: number; my_list_status?: ListStatus }

function auth(ctx: Ctx): MalAuth | undefined {
  const a = ctx.cfg.trackers.mal;
  if (!a || !a.accessToken) return undefined;
  if (!ctx.env.DB && a.expiresAt && (a.expiresAt < 1e12 ? a.expiresAt * 1000 : a.expiresAt) <= Date.now()) return undefined;
  return a;
}

function headers(a: MalAuth, form = false): Record<string, string> {
  return { authorization: `Bearer ${a.accessToken}`, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) };
}

async function get<T>(ctx: Ctx, a: MalAuth, path: string, ttl: number): Promise<T | null> {
  const result = await fetchJson<T>(`${API}${path}`, { headers: headers(a), ttl, cacheScope: `mal:${ctx.scope}:${await fingerprint(a.accessToken)}` });
  if (ctx.env.DB && result === null) throw new Error('mal read unavailable');
  return result;
}

async function listAll(ctx: Ctx, a: MalAuth, status: MalStatus, fields: string, ttl: number, maxPages = 100): Promise<ListRow[]> {
  const rows: ListRow[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < maxPages; i++) {
    const page = await get<ListPage>(ctx, a, `/users/@me/animelist?status=${status}&fields=${fields}&limit=${PAGE}&offset=${i * PAGE}&nsfw=true`, ttl);
    if (!page?.data?.length) return rows;
    const signature = JSON.stringify(page.data);
    if (seen.has(signature)) throw new Error('MAL repeated a list page');
    seen.add(signature);
    rows.push(...page.data);
    if (!page.paging?.next) return rows;
  }
  throw new Error('MAL list exceeds the import limit');
}

async function snapshot(ctx: Ctx): Promise<WatchSnapshot> {
  const initial = auth(ctx);
  const a = initial ? await credentials(ctx, 'mal', initial) : undefined;
  if (!a) return emptySnapshot();
  const [watching, completed, dropped, held] = await Promise.all([
    listAll(ctx, a, 'watching', 'list_status', 60),
    listAll(ctx, a, 'completed', 'list_status,num_episodes', 60),
    listAll(ctx, a, 'dropped', 'list_status,num_episodes', 0),
    listAll(ctx, a, 'on_hold', 'list_status,num_episodes', 60),
  ]);
  const out = emptySnapshot();
  out.dropped = dropped.filter(row => row.node?.id).map(row => ({ mal: row.node.id }));
  for (const row of [...watching, ...completed, ...dropped, ...held]) {
    const mal = row.node?.id;
    if (!mal) continue;
    const ls = row.list_status ?? {};
    const lastAt = isoOrNow(ls.updated_at);
    let seen = Number(ls.num_episodes_watched) || 0;
    if (ls.status === 'completed' && !seen) seen = Number(row.node.num_episodes) || 1;
    const ids = { mal };
    for (let e = 1; e <= seen; e++) out.episodes.push({ ids, season: 1, episode: e, plays: 1, lastAt });
    if (seen > 0) out.shows.push({ ids, lastAt, lastSeason: 1, lastEpisode: seen });
    if (ls.status === 'completed' && Number(row.node.num_episodes) === 1) out.movies.push({ ids, plays: 1, lastAt });
  }
  out.fetchedAt = nowIso();
  return out;
}

async function drop(ctx: Ctx, ev: DropEvent): Promise<void> {
  const initial = auth(ctx);
  const a = initial ? await credentials(ctx, 'mal', initial) : undefined;
  if (!a) throw new Error('MAL credentials unavailable');
  if (!ev.ids.mal) return;
  const cur = await current(ctx, a, ev.ids.mal);
  if (!cur) throw new Error('MAL state unavailable');
  if (!ev.dropped && cur.status !== 'dropped') return;
  const status: MalStatus = ev.dropped ? 'dropped' : cur.total && cur.watched >= cur.total ? 'completed' : cur.watched > 0 ? 'watching' : 'plan_to_watch';
  const result = await sendRequest(`${API}/anime/${ev.ids.mal}/my_list_status`, { method: 'PATCH', headers: headers(a, true), body: new URLSearchParams({ status }).toString() });
  if (!result.ok) throw new Error('MAL drop update rejected');
}

async function current(ctx: Ctx, a: MalAuth, mal: number): Promise<{ watched: number; total: number | null; status?: MalStatus } | null> {
  const d = await get<AnimeDetail>(ctx, a, `/anime/${mal}?fields=id,num_episodes,my_list_status{status,num_episodes_watched}`, 0);
  if (!d) return null;
  return { watched: Number(d.my_list_status?.num_episodes_watched) || 0, total: Number(d.num_episodes) || null, status: d.my_list_status?.status };
}

async function setProgress(a: MalAuth, mal: number, watched: number, total: number | null): Promise<void> {
  const status: MalStatus = total && watched >= total ? 'completed' : watched > 0 ? 'watching' : 'plan_to_watch';
  const form = new URLSearchParams({ status, num_watched_episodes: String(Math.max(0, watched)) });
  const result = await sendRequest(`${API}/anime/${mal}/my_list_status`, { method: 'PATCH', headers: headers(a, true), body: form.toString() });
  if (!result.ok) throw new Error('MAL update rejected');
}

function episodeOf(kind: 'movie' | 'episode' | 'series', episode?: number): number | undefined {
  if (kind === 'movie') return 1;
  if (kind === 'episode') return episode && episode > 0 ? episode : undefined;
  return undefined;
}

async function scrobble(ctx: Ctx, ev: ScrobbleEvent): Promise<void> {
  const initial = auth(ctx);
  const a = initial ? await credentials(ctx, 'mal', initial) : undefined;
  const mal = (ev.animeEpisode ? ev.animeEpisode.mal : ev.ids.mal);
  if (!a || !mal) return;
  if (ev.action !== 'stop' || clampPercent(ev.progress) < WATCHED_AT) return;
  const ep = episodeOf(ev.kind, ev.animeEpisode?.episode ?? ev.episode);
  if (!ep) return;
  const cur = await current(ctx, a, mal);
  if (!cur) throw new Error('MAL state unavailable');
  if (ep > cur.watched) await setProgress(a, mal, ep, cur.total);
}

async function mark(ctx: Ctx, ev: MarkEvent): Promise<void> {
  const initial = auth(ctx);
  const a = initial ? await credentials(ctx, 'mal', initial) : undefined;
  const mal = (ev.animeEpisode ? ev.animeEpisode.mal : ev.ids.mal);
  if (!a || !mal) return;
  const cur = await current(ctx, a, mal);
  if (!cur) throw new Error('Tracker state unavailable');
  if (ev.kind === 'series') {
    if (ev.watched) { if (cur.total) await setProgress(a, mal, cur.total, cur.total); }
    else await setProgress(a, mal, 0, cur.total);
    return;
  }
  const ep = episodeOf(ev.kind, ev.animeEpisode?.episode ?? ev.episode);
  if (!ep) return;
  if (ev.watched) {
    if (ep > cur.watched) await setProgress(a, mal, ep, cur.total);
  } else if (cur.watched >= ep) {
    await setProgress(a, mal, ep - 1, cur.total);
  }
}

const MAL_CATALOGS: Record<string,{name:string;status:MalStatus}> = {
  'mal:ptw':{name:'Plan to Watch',status:'plan_to_watch'},'mal:watching':{name:'Watching',status:'watching'},'mal:completed':{name:'Completed',status:'completed'},'mal:on_hold':{name:'On Hold',status:'on_hold'},'mal:dropped':{name:'Dropped',status:'dropped'},
};

async function catalogs(ctx: Ctx): Promise<ManifestCatalog[]> {
  if (!auth(ctx)) return [];
  return Object.entries(MAL_CATALOGS).map(([id,label]) => ({type:'anime',id,name:'MAL '+label.name,extra:[{name:'skip'}]}));
}

async function catalogItems(ctx: Ctx, catalogId: string, skip: number): Promise<MetaPreview[]> {
  const initial = auth(ctx);
  const a = initial ? await credentials(ctx, 'mal', initial) : undefined;
  const selected=MAL_CATALOGS[catalogId];
  if (!a || !selected) return [];
  const offset = Math.max(0, skip);
  const page = await get<ListPage>(ctx, a, `/users/@me/animelist?status=${selected.status}&fields=list_status,main_picture,start_date,synopsis,genres&sort=list_updated_at&limit=${PAGE}&offset=${offset}&nsfw=true`, 300);
  const out: MetaPreview[] = [];
  for (const row of page?.data ?? []) {
    const n = row.node;
    if (!n?.id) continue;
    const year = n.start_date ? Number(n.start_date.slice(0, 4)) || undefined : undefined;
    out.push({ id: `mal:${n.id}`, type: 'anime', name: n.title ?? `mal:${n.id}`, poster: n.main_picture?.large ?? n.main_picture?.medium, description: n.synopsis, genres: n.genres?.map((g) => g.name), year, releaseInfo: year ? String(year) : undefined });
  }
  return out;
}

export const malTracker: Tracker = {
  name: 'mal',
  ready: (ctx) => !!auth(ctx),
  snapshot,
  drop,
  scrobble,
  mark,
  catalogs,
  catalogItems,
};

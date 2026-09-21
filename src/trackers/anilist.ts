import type { Ctx } from '../context';
import type { AnilistAuth } from '../config/schema';
import type { ManifestCatalog, MetaPreview } from '../stremio/types';
import { memo } from '../util/cache';
import { clampPercent, emptySnapshot, fingerprint, nowIso, sendRequest } from './common';
import type { DropEvent, MarkEvent, ScrobbleEvent, Tracker, WatchSnapshot } from './types';

const API = 'https://graphql.anilist.co';
const WATCHED_AT = 90;

type ListStatus = 'CURRENT' | 'PLANNING' | 'COMPLETED' | 'DROPPED' | 'PAUSED' | 'REPEATING';

interface Media { id: number; idMal?: number | null; episodes?: number | null; title?: { romaji?: string; english?: string }; coverImage?: { large?: string; extraLarge?: string }; description?: string; genres?: string[]; seasonYear?: number | null }
interface Entry { progress?: number; status?: ListStatus; updatedAt?: number; media: Media }
interface Collection { MediaListCollection?: { lists?: Array<{ status?: ListStatus; entries?: Entry[] }> } }
interface Gql<T> { data?: T; errors?: Array<{ message: string }> }

function auth(ctx: Ctx): AnilistAuth | undefined {
  const a = ctx.cfg.trackers.anilist;
  return a && a.accessToken ? a : undefined;
}

async function gql<T>(a: AnilistAuth, query: string, variables: Record<string, unknown>): Promise<T | null> {
  const res = await sendRequest(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${a.accessToken}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = res.body as Gql<T> | null;
  if (!res.ok || body?.errors?.length || !body?.data) return null;
  return body.data;
}

async function scopeKey(ctx: Ctx, a: AnilistAuth, what: string): Promise<string> {
  return `anilist:${what}:${ctx.scope}:${await fingerprint(a.accessToken)}`;
}

async function viewerId(ctx: Ctx, a: AnilistAuth): Promise<number | null> {
  if (a.userId) return a.userId;
  const key = await scopeKey(ctx, a, 'viewer');
  const id = await memo<number | null>(key, 24 * 3600, async () => {
    const d = await gql<{ Viewer?: { id: number } }>(a, 'query { Viewer { id } }', {});
    return d?.Viewer?.id ?? null;
  });
  return id;
}

const COLLECTION = `query ($userId: Int, $status: [MediaListStatus]) {
  MediaListCollection(userId: $userId, type: ANIME, status_in: $status) {
    lists { status entries { progress status updatedAt media { id idMal episodes seasonYear title { romaji english } coverImage { large extraLarge } description(asHtml: false) genres } } }
  }
}`;

async function collection(ctx: Ctx, a: AnilistAuth, statuses: ListStatus[], ttl: number): Promise<Entry[]> {
  const uid = await viewerId(ctx, a);
  if (!uid) { if (ctx.env.DB) throw new Error('AniList user unavailable'); return []; }
  const key = await scopeKey(ctx, a, `coll:${statuses.join(',')}`);
  const entries = await memo<Entry[]>(key, ttl, async () => {
    const d = await gql<Collection>(a, COLLECTION, { userId: uid, status: statuses });
    if (ctx.env.DB && !d?.MediaListCollection) throw new Error('AniList history unavailable');
    const out: Entry[] = [];
    for (const list of d?.MediaListCollection?.lists ?? []) for (const e of list.entries ?? []) if (e?.media?.id) out.push(e);
    return out;
  });
  return entries ?? [];
}

function stamp(updatedAt?: number): string {
  return updatedAt ? new Date(updatedAt * 1000).toISOString() : nowIso();
}

async function snapshot(ctx: Ctx): Promise<WatchSnapshot> {
  const a = auth(ctx);
  if (!a) return emptySnapshot();
  const out = emptySnapshot();
  out.dropped = [];
  for (const e of await collection(ctx, a, ['CURRENT', 'COMPLETED', 'REPEATING', 'PAUSED', 'DROPPED'], 0)) {
    const ids = { anilist: e.media.id, ...(e.media.idMal ? { mal: e.media.idMal } : {}) };
    if (e.status === 'DROPPED') out.dropped.push(ids);
    const lastAt = stamp(e.updatedAt);
    let seen = Number(e.progress) || 0;
    if (e.status === 'COMPLETED' && !seen) seen = Number(e.media.episodes) || 1;
    for (let n = 1; n <= seen; n++) out.episodes.push({ ids, season: 1, episode: n, plays: 1, lastAt });
    if (seen > 0) out.shows.push({ ids, lastAt, lastSeason: 1, lastEpisode: seen });
    if (e.status === 'COMPLETED' && Number(e.media.episodes) === 1) out.movies.push({ ids, plays: 1, lastAt });
  }
  out.fetchedAt = nowIso();
  return out;
}

async function current(a: AnilistAuth, anilist: number): Promise<{ watched: number; total: number | null; status?: ListStatus } | null> {
  const d = await gql<{ Media?: { episodes?: number | null; mediaListEntry?: { progress?: number; status?: ListStatus } | null } }>(
    a,
    'query ($id: Int) { Media(id: $id, type: ANIME) { episodes mediaListEntry { progress status } } }',
    { id: anilist },
  );
  if (!d?.Media) return null;
  return { watched: Number(d.Media.mediaListEntry?.progress) || 0, total: Number(d.Media.episodes) || null, status: d.Media.mediaListEntry?.status };
}

async function drop(ctx: Ctx, ev: DropEvent): Promise<void> {
  const a = auth(ctx);
  if (!a) throw new Error('AniList credentials unavailable');
  if (!ev.ids.anilist) return;
  const cur = await current(a, ev.ids.anilist);
  if (!cur) throw new Error('AniList state unavailable');
  if (!ev.dropped && cur.status !== 'DROPPED') return;
  const status: ListStatus = ev.dropped ? 'DROPPED' : cur.total && cur.watched >= cur.total ? 'COMPLETED' : cur.watched > 0 ? 'CURRENT' : 'PLANNING';
  const saved = await gql<{ SaveMediaListEntry?: { id: number } }>(a,
    'mutation ($id: Int, $status: MediaListStatus) { SaveMediaListEntry(mediaId: $id, status: $status) { id } }', { id: ev.ids.anilist, status });
  if (!saved?.SaveMediaListEntry?.id) throw new Error('AniList drop update rejected');
}

async function save(a: AnilistAuth, anilist: number, progress: number, total: number | null): Promise<void> {
  const status: ListStatus = total && progress >= total ? 'COMPLETED' : progress > 0 ? 'CURRENT' : 'PLANNING';
  const saved = await gql<{ SaveMediaListEntry?: { id: number } }>(a, 'mutation ($id: Int, $progress: Int, $status: MediaListStatus) { SaveMediaListEntry(mediaId: $id, progress: $progress, status: $status) { id } }', { id: anilist, progress: Math.max(0, progress), status });
  if (!saved?.SaveMediaListEntry?.id) throw new Error('AniList update rejected');
}

function episodeOf(kind: 'movie' | 'episode' | 'series', episode?: number): number | undefined {
  if (kind === 'movie') return 1;
  if (kind === 'episode') return episode && episode > 0 ? episode : undefined;
  return undefined;
}

async function scrobble(ctx: Ctx, ev: ScrobbleEvent): Promise<void> {
  const a = auth(ctx);
  const id = (ev.animeEpisode ? ev.animeEpisode.anilist : ev.ids.anilist);
  if (!a || !id) return;
  if (ev.action !== 'stop' || clampPercent(ev.progress) < WATCHED_AT) return;
  const ep = episodeOf(ev.kind, ev.animeEpisode?.episode ?? ev.episode);
  if (!ep) return;
  const cur = await current(a, id);
  if (!cur) throw new Error('AniList state unavailable');
  if (ep > cur.watched) await save(a, id, ep, cur.total);
}

async function mark(ctx: Ctx, ev: MarkEvent): Promise<void> {
  const a = auth(ctx);
  const id = (ev.animeEpisode ? ev.animeEpisode.anilist : ev.ids.anilist);
  if (!a || !id) return;
  const cur = await current(a, id);
  if (!cur) throw new Error('Tracker state unavailable');
  if (ev.kind === 'series') {
    if (ev.watched) { if (cur.total) await save(a, id, cur.total, cur.total); }
    else await save(a, id, 0, cur.total);
    return;
  }
  const ep = episodeOf(ev.kind, ev.animeEpisode?.episode ?? ev.episode);
  if (!ep) return;
  if (ev.watched) { if (ep > cur.watched) await save(a, id, ep, cur.total); }
  else if (cur.watched >= ep) await save(a, id, ep - 1, cur.total);
}

const AL_CATALOGS: Record<string,{name:string;status:ListStatus}> = {
  'anilist:planning':{name:'Planning',status:'PLANNING'},'anilist:current':{name:'Watching',status:'CURRENT'},'anilist:completed':{name:'Completed',status:'COMPLETED'},'anilist:paused':{name:'Paused',status:'PAUSED'},'anilist:dropped':{name:'Dropped',status:'DROPPED'},'anilist:repeating':{name:'Rewatching',status:'REPEATING'},
};

async function catalogs(ctx: Ctx): Promise<ManifestCatalog[]> {
  if (!auth(ctx)) return [];
  return Object.entries(AL_CATALOGS).map(([id,label]) => ({type:'anime',id,name:'AniList '+label.name,extra:[{name:'skip'}]}));
}

async function catalogItems(ctx: Ctx, catalogId: string, skip: number): Promise<MetaPreview[]> {
  const a = auth(ctx);
  const selected=AL_CATALOGS[catalogId];
  if (!a || !selected) return [];
  const entries = await collection(ctx, a, [selected.status], 300);
  entries.sort((x, y) => (y.updatedAt ?? 0) - (x.updatedAt ?? 0));
  return entries.slice(Math.max(0, skip), Math.max(0, skip) + 100).map((e) => {
    const m = e.media;
    const name = m.title?.english ?? m.title?.romaji ?? `anilist:${m.id}`;
    return { id: `anilist:${m.id}`, type: 'anime' as const, name, poster: m.coverImage?.extraLarge ?? m.coverImage?.large, description: m.description ?? undefined, genres: m.genres, year: m.seasonYear ?? undefined, releaseInfo: m.seasonYear ? String(m.seasonYear) : undefined };
  });
}

export const anilistTracker: Tracker = {
  name: 'anilist',
  ready: (ctx) => !!auth(ctx),
  snapshot,
  drop,
  scrobble,
  mark,
  catalogs,
  catalogItems,
};

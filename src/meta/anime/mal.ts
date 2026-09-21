import type { Ctx } from '../../context';
import type { IdBundle } from '../types';
import type { Meta, MetaLink, MetaPreview } from '../../stremio/types';
import { fetchJson, memo } from '../../util/cache';
import { mapLimit } from '../../util/concurrency';
import {
  animeKind, certFromMalRating, cleanSynopsis, dedupeStrings, isoDate, minutesFromJikanDuration, parseSeasonParam,
  pause, ratingLabel, releaseSpan, runtimeLabel, stremioTypeFor, toInt, weekdayParam, yearOf,
} from './shared';

const BASE = 'https://api.jikan.moe/v4';
export const JIKAN_CONCURRENCY = 3;
const TTL_DETAILS = 12 * 3600;
const TTL_LISTS = 3600;
const TTL_EPISODES = 6 * 3600;
const TTL_STATIC = 24 * 3600;
const PAGE_SIZE = 25;
const EPISODES_PER_PAGE = 100;
const MAX_EPISODE_PAGES = 30;

export interface JikanImage { jpg?: { image_url?: string; large_image_url?: string }; webp?: { large_image_url?: string } }
export interface JikanNamed { mal_id: number; name: string; type?: string; url?: string }
export interface JikanAnime {
  mal_id: number;
  url?: string;
  title: string;
  title_english?: string | null;
  title_japanese?: string | null;
  titles?: Array<{ type: string; title: string }>;
  type?: string | null;
  episodes?: number | null;
  status?: string | null;
  airing?: boolean;
  aired?: { from?: string | null; to?: string | null };
  duration?: string | null;
  rating?: string | null;
  score?: number | null;
  synopsis?: string | null;
  year?: number | null;
  season?: string | null;
  images?: JikanImage;
  trailer?: { youtube_id?: string | null; images?: { maximum_image_url?: string | null } };
  genres?: JikanNamed[];
  explicit_genres?: JikanNamed[];
  themes?: JikanNamed[];
  demographics?: JikanNamed[];
  studios?: JikanNamed[];
  producers?: JikanNamed[];
  relations?: Array<{ relation: string; entry: JikanNamed[] }>;
  external?: Array<{ name: string; url: string }>;
  streaming?: Array<{ name: string; url: string }>;
}
export interface JikanEpisode {
  mal_id: number;
  title?: string | null;
  title_romanji?: string | null;
  aired?: string | null;
  filler?: boolean;
  recap?: boolean;
  synopsis?: string | null;
  url?: string | null;
}
interface JikanPage<T> { data: T; pagination?: { last_visible_page?: number; has_next_page?: boolean } }

async function jikanGet<T>(path: string, ttl: number, retry = true): Promise<T | null> {
  const url = `${BASE}${path}`;
  const first = await fetchJson<T>(url, { ttl, timeoutMs: 15000 });
  if (first !== null || !retry) return first;
  await pause(1200);
  return fetchJson<T>(url, { ttl, timeoutMs: 15000 });
}

export async function malDetails(ctx: Ctx, malId: number): Promise<JikanAnime | null> {
  void ctx;
  const res = await jikanGet<JikanPage<JikanAnime>>(`/anime/${malId}/full`, TTL_DETAILS);
  return res?.data?.mal_id ? res.data : null;
}

export async function malEpisodes(ctx: Ctx, malId: number): Promise<JikanEpisode[]> {
  void ctx;
  return memo(`anime:mal:episodes:v1:${malId}`, TTL_EPISODES, async () => {
    const first = await jikanGet<JikanPage<JikanEpisode[]>>(`/anime/${malId}/episodes?page=1`, TTL_EPISODES);
    if (!first?.data) return [];
    const last = Math.min(MAX_EPISODE_PAGES, Math.max(1, Number(first.pagination?.last_visible_page) || 1));
    const rest = Array.from({ length: last - 1 }, (_, i) => i + 2);
    const pages = await mapLimit(rest, JIKAN_CONCURRENCY, (p) => jikanGet<JikanPage<JikanEpisode[]>>(`/anime/${malId}/episodes?page=${p}`, TTL_EPISODES));
    const all = [...first.data];
    for (const pg of pages) if (pg?.data) all.push(...pg.data);
    return all.filter((e) => e && Number.isFinite(e.mal_id));
  });
}

export async function malSearch(ctx: Ctx, query: string, opts: { skip?: number; limit?: number } = {}): Promise<MetaPreview[]> {
  const q = query.trim();
  if (!q) return [];
  const limit = Math.min(PAGE_SIZE, Math.max(1, opts.limit || PAGE_SIZE));
  const page = Math.floor((opts.skip || 0) / limit) + 1;
  const params = new URLSearchParams({ q, limit: String(limit), page: String(page), order_by: 'members', sort: 'desc' });
  if (!ctx.cfg.search.includeAdult) params.set('sfw', 'true');
  const res = await jikanGet<JikanPage<JikanAnime[]>>(`/anime?${params}`, TTL_LISTS);
  return (res?.data || []).map(malPreview);
}

export type MalListKind = 'top' | 'season' | 'schedule' | 'genre' | 'studio' | 'decade';

export async function malList(ctx: Ctx, kind: MalListKind, params: Record<string, string>, page: number): Promise<MetaPreview[]> {
  const p = Math.max(1, Math.floor(page || 1));
  const sfw = ctx.cfg.search.includeAdult ? '' : '&sfw=true';
  const common = `page=${p}&limit=${PAGE_SIZE}`;
  let path: string | null = null;
  let filterKinds = false;
  switch (kind) {
    case 'top': {
      const qs = new URLSearchParams();
      if (params.filter) qs.set('filter', params.filter);
      if (params.type) qs.set('type', jikanType(params.type));
      path = `/top/anime?${common}&${qs}${sfw}`;
      break;
    }
    case 'season': {
      const when = (params.season || 'now').toLowerCase();
      const type = params.type ? `&filter=${jikanType(params.type)}` : '';
      if (when === 'now' || when === 'current') path = `/seasons/now?${common}${type}${sfw}`;
      else if (when === 'upcoming') path = `/seasons/upcoming?${common}${type}${sfw}`;
      else { const s = parseSeasonParam(when); path = `/seasons/${s.year}/${s.season}?${common}${type}${sfw}`; }
      break;
    }
    case 'schedule':
      path = `/schedules?filter=${weekdayParam(params.day)}&${common}${sfw}`;
      break;
    case 'genre': {
      const id = toInt(params.id) ?? (params.name ? await malGenreId(params.name) : undefined);
      if (!id) return [];
      const type = params.type ? `&type=${jikanType(params.type)}` : '';
      path = `/anime?genres=${id}&order_by=members&sort=desc&${common}${type}${sfw}`;
      filterKinds = true;
      break;
    }
    case 'studio': {
      const id = toInt(params.id) ?? (params.name ? await malStudioId(params.name) : undefined);
      if (!id) return [];
      path = `/anime?producers=${id}&order_by=members&sort=desc&${common}${sfw}`;
      break;
    }
    case 'decade': {
      const start = toInt(params.decade) ?? Math.floor(new Date().getUTCFullYear() / 10) * 10;
      const genre = params.genre ? (toInt(params.genre) ?? await malGenreId(params.genre)) : undefined;
      const g = genre ? `&genres=${genre}` : '';
      path = `/anime?start_date=${start}-01-01&end_date=${start + 9}-12-31&order_by=members&sort=desc&${common}${g}${sfw}`;
      break;
    }
  }
  if (!path) return [];
  const res = await jikanGet<JikanPage<JikanAnime[]>>(path, TTL_LISTS);
  let items = res?.data || [];
  if (filterKinds) items = items.filter((a) => ['TV', 'MOVIE', 'OVA', 'ONA'].includes(animeKind(a.type)));
  const seen = new Set<number>();
  return items.filter((a) => a?.mal_id && !seen.has(a.mal_id) && seen.add(a.mal_id)).map(malPreview);
}

function jikanType(type: string): string {
  const t = type.toLowerCase();
  if (t === 'series') return 'tv';
  return ['tv', 'movie', 'ova', 'ona', 'special', 'music'].includes(t) ? t : 'tv';
}

export async function malGenres(): Promise<JikanNamed[]> {
  const res = await jikanGet<JikanPage<JikanNamed[]>>('/genres/anime', TTL_STATIC);
  return res?.data || [];
}

async function malGenreId(name: string): Promise<number | undefined> {
  const n = name.trim().toLowerCase();
  const all = await malGenres();
  return all.find((g) => g.name.toLowerCase() === n)?.mal_id ?? all.find((g) => g.name.toLowerCase().includes(n))?.mal_id;
}

async function malStudioId(name: string): Promise<number | undefined> {
  const res = await jikanGet<JikanPage<Array<{ mal_id: number; titles?: Array<{ type: string; title: string }> }>>>(
    `/producers?q=${encodeURIComponent(name.trim())}&limit=5`, TTL_STATIC);
  const n = name.trim().toLowerCase();
  const rows = res?.data || [];
  const exact = rows.find((r) => (r.titles || []).some((t) => t.title.toLowerCase() === n));
  return (exact || rows[0])?.mal_id;
}

export async function malExternalIds(ctx: Ctx, malId: number): Promise<Partial<IdBundle>> {
  void ctx;
  const res = await jikanGet<JikanPage<Array<{ name: string; url: string }>>>(`/anime/${malId}/external`, TTL_DETAILS, false);
  const out: Partial<IdBundle> = {};
  for (const link of res?.data || []) {
    const u = link.url || '';
    const anidb = /anidb\.net\/(?:anime\/|.*aid=)(\d+)/i.exec(u);
    const anilist = /anilist\.co\/anime\/(\d+)/i.exec(u);
    const kitsu = /kitsu\.(?:io|app)\/anime\/(\d+)/i.exec(u);
    if (anidb && !out.anidb) out.anidb = Number(anidb[1]);
    if (anilist && !out.anilist) out.anilist = Number(anilist[1]);
    if (kitsu && !out.kitsu) out.kitsu = Number(kitsu[1]);
  }
  return out;
}

export function malTitle(a: JikanAnime, lang?: string): string {
  if (lang && lang.startsWith('ja') && a.title_japanese) return a.title_japanese;
  return a.title_english || a.title;
}

export function malPoster(a: JikanAnime): string | undefined {
  return a.images?.jpg?.large_image_url || a.images?.webp?.large_image_url || a.images?.jpg?.image_url || undefined;
}

export function malGenreNames(a: JikanAnime): string[] {
  return dedupeStrings([...(a.genres || []), ...(a.explicit_genres || []), ...(a.themes || []), ...(a.demographics || [])].map((g) => g.name));
}

export function malPreview(a: JikanAnime): MetaPreview {
  const kind = animeKind(a.type);
  const start = isoDate(a.aired?.from);
  return {
    id: `mal:${a.mal_id}`,
    type: stremioTypeFor(kind),
    name: malTitle(a),
    poster: malPoster(a),
    posterShape: 'poster',
    description: cleanSynopsis(a.synopsis),
    genres: malGenreNames(a),
    imdbRating: ratingLabel(a.score, 10),
    releaseInfo: releaseSpan(start, isoDate(a.aired?.to), Boolean(a.airing), kind === 'MOVIE'),
    year: a.year || yearOf(start),
  };
}

export function malLinks(a: JikanAnime): MetaLink[] {
  const links: MetaLink[] = [];
  if (a.url) links.push({ name: 'MyAnimeList', category: 'External', url: a.url });
  for (const g of malGenreNames(a)) links.push({ name: g, category: 'Genres', url: `stremio:///search?search=${encodeURIComponent(g)}` });
  for (const s of a.studios || []) links.push({ name: s.name, category: 'Studios', url: `stremio:///search?search=${encodeURIComponent(s.name)}` });
  for (const rel of a.relations || []) {
    for (const e of rel.entry || []) {
      if (e.type === 'anime') links.push({ name: `${rel.relation}: ${e.name}`, category: 'Related', url: `stremio:///detail/series/mal:${e.mal_id}` });
    }
  }
  return links;
}

export function malMeta(a: JikanAnime, lang?: string): Meta {
  const kind = animeKind(a.type);
  const base = malPreview(a);
  base.name = malTitle(a, lang);
  const minutes = minutesFromJikanDuration(a.duration);
  const meta: Meta = {
    ...base,
    background: a.trailer?.images?.maximum_image_url || undefined,
    runtime: runtimeLabel(minutes),
    released: isoDate(a.aired?.from),
    certification: certFromMalRating(a.rating),
    links: malLinks(a),
    trailers: a.trailer?.youtube_id ? [{ source: a.trailer.youtube_id, type: 'Trailer' }] : [],
    status: a.status || undefined,
    network: a.studios?.[0]?.name,
    ids: { mal: a.mal_id },
    videos: [],
  };
  if (kind === 'MOVIE') meta.behaviorHints = { defaultVideoId: `mal:${a.mal_id}`, hasScheduledVideos: false };
  return meta;
}

export function malEpisodeRows(eps: JikanEpisode[]): Array<{ episode: number; title: string; released?: string; overview?: string; filler?: boolean; recap?: boolean }> {
  return eps.map((e) => ({
    episode: e.mal_id,
    title: (e.title || e.title_romanji || '').trim() || `Episode ${e.mal_id}`,
    released: isoDate(e.aired),
    overview: cleanSynopsis(e.synopsis),
    filler: Boolean(e.filler),
    recap: Boolean(e.recap),
  }));
}

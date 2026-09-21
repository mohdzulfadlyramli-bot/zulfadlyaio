import type { Ctx } from '../../context';
import type { IdBundle } from '../types';
import type { Meta, MetaLink, MetaPreview } from '../../stremio/types';
import { fetchJson, memo } from '../../util/cache';
import { mapLimit } from '../../util/concurrency';
import {
  animeKind, certFromKitsuRating, cleanSynopsis, dedupeStrings, isoDate, parseSeasonParam, ratingLabel, releaseSpan,
  runtimeLabel, stremioTypeFor, toInt,
} from './shared';

const BASE = 'https://kitsu.io/api/edge';
const HEADERS = { accept: 'application/vnd.api+json', 'content-type': 'application/vnd.api+json' };
const TTL_DETAILS = 12 * 3600;
const TTL_LISTS = 3600;
const TTL_EPISODES = 6 * 3600;
const TTL_IDS = 7 * 24 * 3600;
const PAGE_SIZE = 20;
const MAX_EPISODE_PAGES = 60;

export interface KitsuImage { original?: string; large?: string; medium?: string; small?: string }
export interface KitsuAnimeAttrs {
  slug?: string;
  synopsis?: string | null;
  description?: string | null;
  titles?: Record<string, string | null>;
  canonicalTitle?: string;
  abbreviatedTitles?: string[] | null;
  averageRating?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  ageRating?: string | null;
  ageRatingGuide?: string | null;
  subtype?: string | null;
  status?: string | null;
  posterImage?: KitsuImage | null;
  coverImage?: KitsuImage | null;
  episodeCount?: number | null;
  episodeLength?: number | null;
  totalLength?: number | null;
  youtubeVideoId?: string | null;
  nsfw?: boolean;
}
export interface KitsuResource<A> { id: string; type: string; attributes: A; relationships?: Record<string, { data?: Array<{ id: string; type: string }> | { id: string; type: string } | null }> }
export interface KitsuEpisodeAttrs {
  canonicalTitle?: string | null;
  titles?: Record<string, string | null>;
  synopsis?: string | null;
  number?: number | null;
  relativeNumber?: number | null;
  seasonNumber?: number | null;
  airdate?: string | null;
  length?: number | null;
  thumbnail?: KitsuImage | null;
}
interface KitsuMappingAttrs { externalSite: string; externalId: string }
interface KitsuDoc<T> { data: T; included?: Array<KitsuResource<Record<string, unknown>>>; meta?: { count?: number }; links?: { next?: string } }

export interface KitsuAnime { res: KitsuResource<KitsuAnimeAttrs>; categories: string[] }

async function kitsuGet<T>(path: string, ttl: number): Promise<T | null> {
  return fetchJson<T>(`${BASE}${path}`, { ttl, headers: HEADERS, timeoutMs: 12000 });
}

export async function kitsuDetails(ctx: Ctx, kitsuId: number): Promise<KitsuAnime | null> {
  void ctx;
  const doc = await kitsuGet<KitsuDoc<KitsuResource<KitsuAnimeAttrs>>>(`/anime/${kitsuId}?include=categories&fields[categories]=title`, TTL_DETAILS);
  if (!doc?.data?.id) return null;
  const categories = (doc.included || []).filter((i) => i.type === 'categories').map((i) => String(i.attributes.title || '')).filter(Boolean);
  return { res: doc.data, categories };
}

export async function kitsuEpisodes(ctx: Ctx, kitsuId: number): Promise<KitsuResource<KitsuEpisodeAttrs>[]> {
  void ctx;
  return memo(`anime:kitsu:episodes:v1:${kitsuId}`, TTL_EPISODES, async () => {
    const path = (offset: number) => `/anime/${kitsuId}/episodes?page[limit]=${PAGE_SIZE}&page[offset]=${offset}&sort=number`;
    const first = await kitsuGet<KitsuDoc<KitsuResource<KitsuEpisodeAttrs>[]>>(path(0), TTL_EPISODES);
    if (!first?.data) return [];
    const total = Number(first.meta?.count) || first.data.length;
    const pages = Math.min(MAX_EPISODE_PAGES, Math.ceil(total / PAGE_SIZE));
    const offsets = Array.from({ length: Math.max(0, pages - 1) }, (_, i) => (i + 1) * PAGE_SIZE);
    const rest = await mapLimit(offsets, 3, (o) => kitsuGet<KitsuDoc<KitsuResource<KitsuEpisodeAttrs>[]>>(path(o), TTL_EPISODES));
    const all = [...first.data];
    for (const pg of rest) if (pg?.data) all.push(...pg.data);
    return all;
  });
}

export async function kitsuSearch(ctx: Ctx, text: string, opts: { skip?: number; limit?: number } = {}): Promise<MetaPreview[]> {
  const q = text.trim();
  if (!q) return [];
  const limit = Math.min(PAGE_SIZE, Math.max(1, opts.limit || PAGE_SIZE));
  const qs = new URLSearchParams({ 'filter[text]': q, 'page[limit]': String(limit), 'page[offset]': String(opts.skip || 0) });
  const doc = await kitsuGet<KitsuDoc<KitsuResource<KitsuAnimeAttrs>[]>>(`/anime?${qs}`, TTL_LISTS);
  return (doc?.data || []).filter((r) => ctx.cfg.search.includeAdult || !r.attributes.nsfw).map((r) => kitsuPreview(r, ctx.lang));
}

export type KitsuListKind = 'trending' | 'popular' | 'top' | 'category' | 'season' | 'airing' | 'upcoming';

export async function kitsuList(ctx: Ctx, kind: KitsuListKind, params: Record<string, string>, page: number): Promise<MetaPreview[]> {
  const p = Math.max(1, Math.floor(page || 1));
  if (kind === 'trending') {
    if (p > 1) return [];
    const doc = await kitsuGet<KitsuDoc<KitsuResource<KitsuAnimeAttrs>[]>>('/trending/anime?limit=20', TTL_LISTS);
    return (doc?.data || []).map((r) => kitsuPreview(r, ctx.lang));
  }
  const qs = new URLSearchParams({ 'page[limit]': String(PAGE_SIZE), 'page[offset]': String((p - 1) * PAGE_SIZE) });
  let sort = '-userCount';
  switch (kind) {
    case 'top': sort = '-averageRating'; break;
    case 'category': if (!params.category) return []; qs.set('filter[categories]', params.category.toLowerCase()); break;
    case 'season': { const s = parseSeasonParam(params.season); qs.set('filter[season]', s.season); qs.set('filter[seasonYear]', String(s.year)); break; }
    case 'airing': qs.set('filter[status]', 'current'); break;
    case 'upcoming': qs.set('filter[status]', 'upcoming'); sort = '-userCount'; break;
  }
  if (params.subtype) qs.set('filter[subtype]', params.subtype.toLowerCase());
  qs.set('sort', sort);
  const doc = await kitsuGet<KitsuDoc<KitsuResource<KitsuAnimeAttrs>[]>>(`/anime?${qs}`, TTL_LISTS);
  return (doc?.data || []).filter((r) => ctx.cfg.search.includeAdult || !r.attributes.nsfw).map((r) => kitsuPreview(r, ctx.lang));
}

export async function kitsuExternalIds(ctx: Ctx, kitsuId: number): Promise<Partial<IdBundle>> {
  void ctx;
  const doc = await kitsuGet<KitsuDoc<KitsuResource<KitsuMappingAttrs>[]>>(`/anime/${kitsuId}/mappings`, TTL_IDS);
  const out: Partial<IdBundle> = {};
  for (const m of doc?.data || []) {
    const site = m.attributes.externalSite;
    const ext = m.attributes.externalId;
    const n = toInt(ext);
    if (site === 'myanimelist/anime' && n) out.mal = n;
    else if (site === 'anilist/anime' && n) out.anilist = n;
    else if (site === 'anidb' && n) out.anidb = n;
    else if (site === 'thetvdb/series' && n) out.tvdb = n;
    else if (site === 'thetvdb' && n) out.tvdb = n;
    else if (site === 'imdb' && /^tt\d+$/.test(ext)) out.imdb = ext;
  }
  return out;
}

export async function kitsuLookupByExternal(ctx: Ctx, site: 'myanimelist/anime' | 'anilist/anime' | 'anidb', externalId: number): Promise<number | undefined> {
  void ctx;
  const qs = new URLSearchParams({ 'filter[externalSite]': site, 'filter[externalId]': String(externalId), include: 'item', 'fields[anime]': 'slug' });
  const doc = await kitsuGet<KitsuDoc<KitsuResource<KitsuMappingAttrs>[]>>(`/mappings?${qs}`, TTL_IDS);
  for (const m of doc?.data || []) {
    const item = m.relationships?.item?.data;
    if (item && !Array.isArray(item) && item.type === 'anime') return toInt(item.id);
  }
  return undefined;
}

export function kitsuTitle(a: KitsuAnimeAttrs, lang?: string): string {
  const t = a.titles || {};
  const base = (lang || 'en').toLowerCase().slice(0, 2);
  const keys = [base, `${base}_us`, `${base}_jp`, 'en', 'en_us', 'en_jp', 'ja_jp'];
  for (const k of keys) { const v = t[k]; if (v && v.trim()) return v.trim(); }
  return a.canonicalTitle || Object.values(t).find((v): v is string => Boolean(v)) || 'Unknown';
}

export function kitsuPoster(a: KitsuAnimeAttrs): string | undefined {
  return a.posterImage?.original || a.posterImage?.large || a.posterImage?.medium || undefined;
}

export function kitsuPreview(r: KitsuResource<KitsuAnimeAttrs>, lang?: string, categories: string[] = []): MetaPreview {
  const a = r.attributes;
  const kind = animeKind(a.subtype);
  const start = isoDate(a.startDate);
  return {
    id: `kitsu:${r.id}`,
    type: stremioTypeFor(kind),
    name: kitsuTitle(a, lang),
    poster: kitsuPoster(a),
    posterShape: 'poster',
    background: a.coverImage?.original || a.coverImage?.large || undefined,
    description: cleanSynopsis(a.synopsis || a.description),
    genres: dedupeStrings(categories),
    imdbRating: ratingLabel(Number(a.averageRating), 100),
    releaseInfo: releaseSpan(start, isoDate(a.endDate), a.status === 'current', kind === 'MOVIE'),
    year: start ? Number(start.slice(0, 4)) : undefined,
  };
}

export function kitsuMeta(k: KitsuAnime, lang?: string): Meta {
  const a = k.res.attributes;
  const kind = animeKind(a.subtype);
  const base = kitsuPreview(k.res, lang, k.categories);
  const links: MetaLink[] = [];
  if (a.slug) links.push({ name: 'Kitsu', category: 'External', url: `https://kitsu.app/anime/${a.slug}` });
  for (const g of k.categories) links.push({ name: g, category: 'Genres', url: `stremio:///search?search=${encodeURIComponent(g)}` });
  const meta: Meta = {
    ...base,
    runtime: runtimeLabel(kind === 'MOVIE' ? a.totalLength || a.episodeLength : a.episodeLength),
    released: isoDate(a.startDate),
    certification: certFromKitsuRating(a.ageRating),
    links,
    trailers: a.youtubeVideoId ? [{ source: a.youtubeVideoId, type: 'Trailer' }] : [],
    status: a.status || undefined,
    ids: { kitsu: Number(k.res.id) },
    videos: [],
  };
  if (kind === 'MOVIE') meta.behaviorHints = { defaultVideoId: `kitsu:${k.res.id}`, hasScheduledVideos: false };
  return meta;
}

export function kitsuEpisodeRows(eps: KitsuResource<KitsuEpisodeAttrs>[], lang?: string): Array<{ episode: number; title?: string; thumbnail?: string; released?: string; overview?: string; runtime?: number }> {
  const out: Array<{ episode: number; title?: string; thumbnail?: string; released?: string; overview?: string; runtime?: number }> = [];
  for (const e of eps) {
    const a = e.attributes;
    const n = Number(a.number);
    if (!Number.isFinite(n) || n <= 0) continue;
    const t = a.titles || {};
    const base = (lang || 'en').toLowerCase().slice(0, 2);
    const title = (t[base] || t.en_us || t.en || a.canonicalTitle || t.en_jp || '').trim();
    out.push({
      episode: n,
      title: title || undefined,
      thumbnail: a.thumbnail?.original || a.thumbnail?.large || undefined,
      released: isoDate(a.airdate),
      overview: cleanSynopsis(a.synopsis),
      runtime: a.length || undefined,
    });
  }
  return out.sort((x, y) => x.episode - y.episode);
}

import type { Ctx } from '../context';
import { episodeId } from '../stremio/ids';
import type { Meta, MetaLink, MetaPreview, MetaVideo } from '../stremio/types';
import { sha256 } from '../util/bytes';
import { fetchJson, memo } from '../util/cache';
import { tvdbLanguage, tvdbLanguageChain } from './language';
import { buildLinks, runtimeText, searchLink, toIsoNoon } from './tmdb';
import type { IdBundle } from './types';

const API = 'https://api4.thetvdb.com/v4';
const ART = 'https://artworks.thetvdb.com';

export const TTL_TOKEN = 24 * 3600;
export const TTL_RECORD = 12 * 3600;
export const TTL_EPISODES = 6 * 3600;
export const TTL_SEARCH = 3600;
export const TTL_REMOTE = 7 * 24 * 3600;

export type TvdbKind = 'series' | 'movie';

export interface TvdbArtworkRow { id?: number; image: string; thumbnail?: string; type: number; language?: string | null; score?: number; width?: number; height?: number }
export interface TvdbRemoteId { id: string; type?: number; sourceName?: string }
export interface TvdbCharacter { name?: string; personName?: string; peopleType?: string; sort?: number }
export interface TvdbTranslationRow { language: string; name?: string; overview?: string }

export interface TvdbRecord {
  id: number;
  name: string;
  slug?: string;
  image?: string | null;
  overview?: string;
  year?: string;
  firstAired?: string; lastAired?: string; nextAired?: string;
  runtime?: number | null; averageRuntime?: number | null;
  status?: { name?: string; id?: number } | null;
  originalCountry?: string; originalLanguage?: string;
  genres?: Array<{ name: string }>;
  characters?: TvdbCharacter[];
  remoteIds?: TvdbRemoteId[];
  artworks?: TvdbArtworkRow[];
  trailers?: Array<{ url?: string; language?: string; name?: string }>;
  translations?: { nameTranslations?: TvdbTranslationRow[]; overviewTranslations?: TvdbTranslationRow[] };
  latestNetwork?: { name?: string } | null; originalNetwork?: { name?: string } | null;
  companies?: unknown;
  seasons?: Array<{ id: number; number: number; image?:string; type?: { type?: string } }>;
  first_release?: { date?: string } | null;
  releases?: Array<{ country?: string; date?: string }>;
  contentRatings?: Array<{ name?: string; country?: string; contentType?: string }>;
  defaultSeasonType?: number;
}

export interface TvdbEpisodeRow {
  id: number; name?: string | null; overview?: string | null; number: number; seasonNumber: number; absoluteNumber?: number | null;
  image?: string | null; aired?: string | null; runtime?: number | null;
}

export interface TvdbSearchRow {
  tvdb_id: string; name: string; year?: string; type: string; image_url?: string; overview?: string; first_air_time?: string;
  network?: string; country?: string; status?: string; primary_language?: string;
  remote_ids?: Array<{ id: string; type?: number; sourceName?: string }>;
  translations?: Record<string, string>; overviews?: Record<string, string>;
}

interface Envelope<T> { status?: string; data?: T; links?: { next?: string | null; total_items?: number } }

export function hasTvdb(ctx: Ctx): boolean {
  return !!ctx.cfg.keys.tvdb;
}

async function tvdbToken(ctx: Ctx): Promise<string | null> {
  const key = ctx.cfg.keys.tvdb;
  if (!key) return null;
  const id = (await sha256(key)).slice(0, 16);
  const token = await memo<string | null>(`tvdb:token:${id}`, TTL_TOKEN, async () => {
    const res = await fetchJson<Envelope<{ token?: string }>>(`${API}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ apikey: key }),
      timeoutMs: 15000,
    });
    return res?.data?.token ?? null;
  });
  return token ?? null;
}

async function tvdbRaw<T>(ctx: Ctx, path: string, ttl: number): Promise<Envelope<T> | null> {
  const token = await tvdbToken(ctx);
  if (!token) return null;
  const run = () => fetchJson<Envelope<T>>(`${API}${path}`, { ttl: 0, headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, timeoutMs: 15000 });
  if (ttl <= 0) return run();
  const hit = await memo<Envelope<T> | null>(`tvdb:${path}`, ttl, run);
  return hit ?? null;
}

export async function tvdbGet<T>(ctx: Ctx, path: string, ttl: number): Promise<T | null> {
  return (await tvdbRaw<T>(ctx, path, ttl))?.data ?? null;
}

export async function tvdbSeries(ctx: Ctx, id: number): Promise<TvdbRecord | null> {
  return tvdbGet<TvdbRecord>(ctx, `/series/${id}/extended?meta=translations`, TTL_RECORD);
}

export async function tvdbMovie(ctx: Ctx, id: number): Promise<TvdbRecord | null> {
  return tvdbGet<TvdbRecord>(ctx, `/movies/${id}/extended?meta=translations`, TTL_RECORD);
}

export async function tvdbRecord(ctx: Ctx, kind: TvdbKind, id: number): Promise<TvdbRecord | null> {
  return kind === 'movie' ? tvdbMovie(ctx, id) : tvdbSeries(ctx, id);
}

async function episodePages(ctx: Ctx, id: number, order: string): Promise<TvdbEpisodeRow[]> {
  const out: TvdbEpisodeRow[] = [];
  for (let page = 0; page < 30; page++) {
    const env = await tvdbRaw<{ episodes?: TvdbEpisodeRow[] }>(ctx, `/series/${id}/episodes/${order}?page=${page}`, TTL_EPISODES);
    if (!env?.data) break;
    out.push(...(env.data.episodes ?? []));
    if (!env.links?.next) break;
  }
  return out;
}

export async function tvdbEpisodes(ctx: Ctx, id: number): Promise<TvdbEpisodeRow[]> {
  const langs = tvdbLanguageChain(ctx.cfg.language);
  for (const l of langs) {
    const rows = await episodePages(ctx, id, `default/${l}`);
    if (rows.length) return rows;
  }
  return episodePages(ctx, id, 'official');
}

function imdbFromRemote(rows: Array<{ id?: string; sourceName?: string; type?: number }> | undefined): string | undefined {
  const hit = (rows ?? []).find((r) => /^tt\d+$/.test(String(r.id || '')) && (r.sourceName?.toLowerCase().includes('imdb') || r.type === 2 || !r.sourceName));
  return hit?.id;
}

function tmdbFromRemote(rows: TvdbRemoteId[] | undefined): number | undefined {
  const hit = (rows ?? []).find((r) => /themoviedb|tmdb/i.test(r.sourceName || '') && /^\d+$/.test(r.id));
  return hit ? Number(hit.id) : undefined;
}

export function idsFromRecord(rec: TvdbRecord): IdBundle {
  return { tvdb: rec.id, imdb: imdbFromRemote(rec.remoteIds), tmdb: tmdbFromRemote(rec.remoteIds) };
}

export function previewFromSearch(row: TvdbSearchRow, lang3: string): MetaPreview {
  const imdb = imdbFromRemote(row.remote_ids);
  const year = row.year ? Number(row.year) : undefined;
  return {
    id: imdb || `tvdb:${row.tvdb_id}`,
    type: row.type === 'movie' ? 'movie' : 'series',
    name: row.translations?.[lang3] || row.name,
    poster: row.image_url && !row.image_url.includes('/images/missing/') ? row.image_url : undefined,
    description: row.overviews?.[lang3] || row.overviews?.eng || row.overview || undefined,
    releaseInfo: row.year || undefined,
    year: Number.isFinite(year) ? year : undefined,
    posterShape: 'poster',
  };
}

export async function tvdbSearch(ctx: Ctx, kind: TvdbKind, query: string, opts: { skip?: number; limit?: number } = {}): Promise<MetaPreview[]> {
  const q = query.trim();
  if (!q || !hasTvdb(ctx)) return [];
  const limit = Math.min(50, opts.limit ?? 20);
  const offset = opts.skip ?? 0;
  const rows = await tvdbGet<TvdbSearchRow[]>(ctx, `/search?query=${encodeURIComponent(q)}&type=${kind}&limit=${limit}&offset=${offset}`, TTL_SEARCH);
  const lang3 = tvdbLanguage(ctx.cfg.language);
  return (rows ?? []).filter((r) => r.network !== 'YouTube').map((r) => previewFromSearch(r, lang3));
}

export async function tvdbByRemoteId(ctx: Ctx, remote: string, kind: TvdbKind): Promise<number | undefined> {
  if (!hasTvdb(ctx) || !remote) return undefined;
  const rows = await tvdbGet<Array<Record<string, { id?: number }>>>(ctx, `/search/remoteid/${encodeURIComponent(remote)}`, TTL_REMOTE);
  const hit = (rows ?? []).find((r) => r[kind]?.id);
  return hit?.[kind]?.id;
}

const ART_TYPES: Record<TvdbKind, { poster: number; background: number; logo: number; banner: number }> = {
  series: { poster: 2, background: 3, logo: 23, banner: 1 },
  movie: { poster: 14, background: 15, logo: 25, banner: 16 },
};

export function artworkUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  return /^https?:\/\//.test(path) ? path : `${ART}${path.startsWith('/') ? '' : '/banners/'}${path}`;
}

export function pickTvdbArtwork(rows: TvdbArtworkRow[] | undefined, type: number, lang3: string): string | undefined {
  const list = (rows ?? []).filter((a) => a.type === type && a.image);
  if (!list.length) return undefined;
  const byScore = (a: TvdbArtworkRow, b: TvdbArtworkRow) => (b.score ?? 0) - (a.score ?? 0);
  for (const pred of [
    (a: TvdbArtworkRow) => a.language === lang3,
    (a: TvdbArtworkRow) => a.language === 'eng',
    (a: TvdbArtworkRow) => !a.language,
    () => true,
  ]) {
    const hit = list.filter(pred).sort(byScore)[0];
    if (hit) return artworkUrl(hit.image);
  }
  return undefined;
}

export interface TvdbArtwork { poster?: string; background?: string; logo?: string; banner?: string }

export function artworkFromRecord(rec: TvdbRecord, kind: TvdbKind, lang3: string): TvdbArtwork {
  const t = ART_TYPES[kind];
  return {
    poster: pickTvdbArtwork(rec.artworks, t.poster, lang3) ?? artworkUrl(rec.image),
    background: pickTvdbArtwork(rec.artworks, t.background, lang3) ?? (kind === 'movie' ? pickTvdbArtwork(rec.artworks, 3, lang3) : undefined),
    logo: pickTvdbArtwork(rec.artworks, t.logo, lang3),
    banner: pickTvdbArtwork(rec.artworks, t.banner, lang3),
  };
}

export async function tvdbArtwork(ctx: Ctx, kind: TvdbKind, id: number): Promise<TvdbArtwork> {
  const rec = await tvdbRecord(ctx, kind, id);
  return rec ? artworkFromRecord(rec, kind, tvdbLanguage(ctx.cfg.language)) : {};
}

function translatedName(rec: TvdbRecord, langs: string[]): string {
  for (const l of langs) {
    const hit = rec.translations?.nameTranslations?.find((t) => t.language === l && t.name);
    if (hit?.name) return hit.name;
  }
  return rec.name;
}

function translatedOverview(rec: TvdbRecord, langs: string[]): string | undefined {
  for (const l of langs) {
    const hit = rec.translations?.overviewTranslations?.find((t) => t.language === l && t.overview);
    if (hit?.overview) return hit.overview;
  }
  return rec.overview || undefined;
}

function people(rec: TvdbRecord, role: string, max = 15): string[] {
  const out: string[] = [];
  for (const c of (rec.characters ?? []).slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))) {
    if (c.peopleType === role && c.personName && !out.includes(c.personName)) out.push(c.personName);
    if (out.length >= max) break;
  }
  return out;
}

function youtubeKey(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = /(?:youtu\.be\/|[?&]v=|\/embed\/)([A-Za-z0-9_-]{6,})/.exec(url);
  return m?.[1];
}

function certificationOf(rec: TvdbRecord, country3: string): string | undefined {
  const rows = rec.contentRatings ?? [];
  const pick = rows.find((r) => r.country === country3)?.name || rows.find((r) => r.country === 'usa')?.name || rows[0]?.name;
  return pick || undefined;
}

const ENDED = new Set(['Ended', 'Cancelled', 'Canceled', 'Released']);

export async function tvdbMeta(ctx: Ctx, kind: TvdbKind, id: number, canonicalId: string, opts: { withEpisodes?: boolean } = {}): Promise<Meta | null> {
  const rec = await tvdbRecord(ctx, kind, id);
  if (!rec) return null;
  const langs = tvdbLanguageChain(ctx.cfg.language);
  const lang3 = langs[0];
  const art = artworkFromRecord(rec, kind, lang3);
  const ids = idsFromRecord(rec);
  const genres = (rec.genres ?? []).map((g) => g.name);
  const cast = people(rec, 'Actor');
  const director = people(rec, 'Director', 5);
  const writer = people(rec, 'Writer', 5);
  const firstDate = kind === 'movie' ? rec.first_release?.date || rec.releases?.[0]?.date || (rec.year ? `${rec.year}-01-01` : undefined) : rec.firstAired;
  const startYear = firstDate ? Number(firstDate.slice(0, 4)) : rec.year ? Number(rec.year) : undefined;
  const status = rec.status?.name;
  const ongoing = kind === 'series' && !!status && !ENDED.has(status);
  const endYear = rec.lastAired ? Number(rec.lastAired.slice(0, 4)) : undefined;
  const releaseInfo = !startYear ? undefined : kind === 'movie' ? String(startYear) : ongoing ? `${startYear}-` : endYear && endYear !== startYear ? `${startYear}-${endYear}` : String(startYear);
  const runtime = rec.runtime ?? rec.averageRuntime;
  const trailers = (rec.trailers ?? [])
    .sort((a, b) => (a.language === lang3 ? 0 : a.language === 'eng' ? 1 : 2) - (b.language === lang3 ? 0 : b.language === 'eng' ? 1 : 2))
    .map((t) => youtubeKey(t.url)).filter((k): k is string => !!k)
    .map((source) => ({ source, type: 'Trailer' as const }));

  const links: MetaLink[] = buildLinks({ imdb: ids.imdb, tmdb: ids.tmdb, kind: kind === 'movie' ? 'movie' : 'tv', genres, cast, director, writer });
  links.push({ name: 'TVDB', category: 'tvdb', url: `https://www.thetvdb.com/${kind === 'movie' ? 'movies' : 'series'}/${rec.slug || rec.id}` });
  if (rec.latestNetwork?.name) links.push(searchLink(rec.latestNetwork.name, 'Network'));

  const meta: Meta = {
    id: canonicalId,
    type: kind === 'movie' ? 'movie' : 'series',
    name: translatedName(rec, langs),
    description: translatedOverview(rec, langs),
    poster: art.poster,
    background: art.background,
    logo: art.logo,
    posterShape: 'poster',
    genres,
    releaseInfo,
    year: startYear && Number.isFinite(startYear) ? startYear : undefined,
    released: firstDate ? toIsoNoon(firstDate) : undefined,
    runtime: runtimeText(runtime),
    cast: cast.length ? cast : undefined,
    director: director.length ? director : undefined,
    writer: writer.length ? writer : undefined,
    country: rec.originalCountry,
    language: rec.originalLanguage,
    certification: certificationOf(rec, 'usa'),
    status,
    network: rec.latestNetwork?.name || rec.originalNetwork?.name || undefined,
    trailers: trailers.length ? trailers.slice(0, 6) : undefined,
    links,
    ids,
    seasonPosters:Object.fromEntries((rec.seasons??[]).filter(s=>s.image&&(!s.type?.type||s.type.type==='official')).map(s=>[s.number,artworkUrl(s.image)!])),
  };

  if (kind === 'movie') {
    meta.behaviorHints = { defaultVideoId: canonicalId, hasScheduledVideos: false };
    return meta;
  }
  if (opts.withEpisodes !== false) {
    const rows = await tvdbEpisodes(ctx, rec.id);
    meta.videos = rows
      .filter((e) => Number.isFinite(e.number) && Number.isFinite(e.seasonNumber))
      .sort((a, b) => a.seasonNumber - b.seasonNumber || a.number - b.number)
      .map((e) => episodeToVideo(canonicalId, e, art.background));
  }
  meta.behaviorHints = { defaultVideoId: null, hasScheduledVideos: ongoing || !!rec.nextAired };
  return meta;
}

export function episodeToVideo(canonicalId: string, e: TvdbEpisodeRow, fallbackThumb?: string): MetaVideo {
  return {
    id: episodeId(canonicalId, e.seasonNumber, e.number),
    title: e.name || `Episode ${e.number}`,
    season: e.seasonNumber,
    episode: e.number,
    released: e.aired ? toIsoNoon(e.aired) : undefined,
    overview: e.overview || undefined,
    thumbnail: artworkUrl(e.image) ?? fallbackThumb,
  };
}

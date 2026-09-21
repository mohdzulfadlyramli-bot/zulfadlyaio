import type { Ctx } from '../context';
import { episodeId } from '../stremio/ids';
import type { ContentType, Meta, MetaLink, MetaPerson, MetaPreview, MetaVideo } from '../stremio/types';
import { fetchJson, memo } from '../util/cache';
import { mapLimit } from '../util/concurrency';
import { languageChain, regionOf, splitLanguageTag, tmdbLanguage } from './language';
import { normalizeRating } from './rating';
import type { IdBundle } from './types';

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

export const TTL_DETAILS = 12 * 3600;
export const TTL_SEASON = 6 * 3600;
export const TTL_LIST = 45 * 60;
export const TTL_FIND = 7 * 24 * 3600;

export type TmdbKind = 'movie' | 'tv';

export interface TmdbImage { file_path: string; iso_639_1: string | null; vote_average: number; width?: number; height?: number }
export interface TmdbGenre { id: number; name: string }
export interface TmdbVideo { key: string; site: string; type: string; iso_639_1?: string; official?: boolean; published_at?: string }
export interface TmdbCast { id?: number; name: string; character?: string; order?: number; profile_path?: string | null; roles?: Array<{ character: string }> }
export interface TmdbCrew { id?: number; name: string; job?: string; department?: string; profile_path?: string | null; jobs?: Array<{ job: string }> }
export interface TmdbTranslation { iso_639_1: string; iso_3166_1: string; data?: { title?: string; name?: string; overview?: string; tagline?: string } }

export interface TmdbEpisode {
  id: number; name: string; overview?: string; air_date?: string | null; episode_number: number; season_number: number;
  still_path?: string | null; runtime?: number | null; vote_average?: number;
}

export interface TmdbSeasonSummary { season_number: number; episode_count: number; name?: string; poster_path?: string | null; air_date?: string | null }

export interface TmdbDetails {
  id: number;
  imdb_id?: string | null;
  title?: string; name?: string; original_title?: string; original_name?: string; original_language?: string;
  overview?: string; tagline?: string;
  poster_path?: string | null; backdrop_path?: string | null;
  release_date?: string; first_air_date?: string; last_air_date?: string;
  runtime?: number | null; episode_run_time?: number[];
  genres?: TmdbGenre[]; status?: string; adult?: boolean;
  vote_average?: number; vote_count?: number; popularity?: number;
  origin_country?: string[]; production_countries?: Array<{ iso_3166_1: string; name: string }>;
  spoken_languages?: Array<{ iso_639_1: string; english_name?: string }>;
  networks?: Array<{ name: string }>; production_companies?: Array<{ name: string }>;
  seasons?: TmdbSeasonSummary[];
  number_of_seasons?: number; number_of_episodes?: number; in_production?: boolean;
  next_episode_to_air?: TmdbEpisode | null; last_episode_to_air?: TmdbEpisode | null;
  belongs_to_collection?: { id: number; name: string } | null;
  external_ids?: { imdb_id?: string | null; tvdb_id?: number | null };
  credits?: { cast?: TmdbCast[]; crew?: TmdbCrew[] };
  aggregate_credits?: { cast?: TmdbCast[]; crew?: TmdbCrew[] };
  videos?: { results?: TmdbVideo[] };
  images?: { posters?: TmdbImage[]; backdrops?: TmdbImage[]; logos?: TmdbImage[] };
  release_dates?: { results?: Array<{ iso_3166_1: string; release_dates: Array<{ certification: string; type: number }> }> };
  content_ratings?: { results?: Array<{ iso_3166_1: string; rating: string }> };
  keywords?: { keywords?: TmdbGenre[]; results?: TmdbGenre[] };
  translations?: { translations?: TmdbTranslation[] };
}

export interface TmdbListItem {
  id: number; title?: string; name?: string; overview?: string; poster_path?: string | null; backdrop_path?: string | null;
  release_date?: string; first_air_date?: string; vote_average?: number; genre_ids?: number[]; media_type?: string; adult?: boolean;
  original_language?: string;
}

interface TmdbPage<T> { page: number; results: T[]; total_pages?: number; total_results?: number }

export interface TmdbArtwork { poster?: string; background?: string; logo?: string; posterLandscape?: string }

function keyMode(key: string): 'bearer' | 'query' {
  return key.length > 40 && key.includes('.') ? 'bearer' : 'query';
}

export async function tmdbGet<T>(ctx: Ctx, path: string, params: Record<string, string | number | boolean | undefined>, ttl: number): Promise<T | null> {
  const key = ctx.tmdbKey;
  if (!key) return null;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const clean = `${path}?${q.toString()}`;
  const run = async (): Promise<T | null> => {
    const mode = keyMode(key);
    const url = mode === 'query' ? `${API}${clean}&api_key=${encodeURIComponent(key)}` : `${API}${clean}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (mode === 'bearer') headers.authorization = `Bearer ${key}`;
    return fetchJson<T>(url, { ttl: 0, headers, timeoutMs: 15000 });
  };
  if (ttl <= 0) return run();
  const hit = await memo<T | null>(`tmdb:${clean}`, ttl, run);
  return hit ?? null;
}

export function tmdbImageUrl(path: string | null | undefined, size: 'w185' | 'w342' | 'w500' | 'w780' | 'w1280' | 'original' = 'w500'): string | undefined {
  return path ? `${IMG}/${size}${path}` : undefined;
}

export function pickImage(images: TmdbImage[] | undefined, lang: string, originalLang?: string | null, preferTextless = false): TmdbImage | undefined {
  if (!images?.length) return undefined;
  const buckets: Record<string, TmdbImage | undefined> = {};
  const put = (slot: string, img: TmdbImage) => {
    const cur = buckets[slot];
    if (!cur || (img.vote_average ?? 0) > (cur.vote_average ?? 0)) buckets[slot] = img;
  };
  for (const img of images) {
    const l = img.iso_639_1;
    if (l === lang) put('lang', img);
    else if (l === 'en') put('en', img);
    else if (originalLang && l === originalLang) put('orig', img);
    else if (!l || l === 'xx') put('none', img);
    else put('any', img);
  }
  const order = preferTextless ? ['none', 'lang', 'en', 'orig', 'any'] : ['lang', 'en', 'orig', 'any', 'none'];
  for (const slot of order) if (buckets[slot]) return buckets[slot];
  return undefined;
}

export function artworkFromDetails(d: TmdbDetails, lang: string): TmdbArtwork {
  const orig = d.original_language;
  const poster = pickImage(d.images?.posters, lang, orig) ?? undefined;
  const backdrop = pickImage(d.images?.backdrops, lang, orig, true);
  const logo = pickImage(d.images?.logos, lang, orig);
  const backdropWithText = pickImage(d.images?.backdrops, lang, orig, false);
  return {
    poster: tmdbImageUrl(poster?.file_path ?? d.poster_path, 'w500'),
    background: tmdbImageUrl(backdrop?.file_path ?? d.backdrop_path, 'original'),
    logo: tmdbImageUrl(logo?.file_path, 'w500'),
    posterLandscape: tmdbImageUrl(backdropWithText?.file_path ?? d.backdrop_path, 'w780'),
  };
}

export async function tmdbImages(ctx: Ctx, kind: TmdbKind, tmdbId: number): Promise<TmdbArtwork> {
  const d = await tmdbDetails(ctx, kind, tmdbId);
  return d ? artworkFromDetails(d, splitLanguageTag(ctx.cfg.language).lang) : {};
}

function appendList(kind: TmdbKind, lang: string): string {
  const base = ['external_ids', 'credits', 'videos', 'images', 'keywords', kind === 'movie' ? 'release_dates' : 'content_ratings'];
  if (kind === 'tv') base.push('aggregate_credits');
  if (lang !== 'en') base.push('translations');
  return base.join(',');
}

export async function tmdbDetails(ctx: Ctx, kind: TmdbKind, tmdbId: number): Promise<TmdbDetails | null> {
  const lang = splitLanguageTag(ctx.cfg.language).lang;
  const imageLangs = [...languageChain(ctx.cfg.language), 'null'].join(',');
  return tmdbGet<TmdbDetails>(ctx, `/${kind}/${tmdbId}`, {
    language: tmdbLanguage(ctx.cfg.language),
    append_to_response: appendList(kind, lang),
    include_image_language: imageLangs,
    include_video_language: `${lang},en`,
  }, TTL_DETAILS);
}

export async function tmdbMovie(ctx: Ctx, tmdbId: number): Promise<TmdbDetails | null> {
  return tmdbDetails(ctx, 'movie', tmdbId);
}

export async function tmdbTv(ctx: Ctx, tmdbId: number): Promise<TmdbDetails | null> {
  return tmdbDetails(ctx, 'tv', tmdbId);
}

export async function tmdbSeason(ctx: Ctx, tmdbId: number, season: number): Promise<{ episodes?: TmdbEpisode[]; poster_path?: string | null } | null> {
  return tmdbGet(ctx, `/tv/${tmdbId}/season/${season}`, { language: tmdbLanguage(ctx.cfg.language) }, TTL_SEASON);
}

export async function tmdbAllEpisodes(ctx: Ctx, d: TmdbDetails): Promise<TmdbEpisode[]> {
  const seasons = (d.seasons ?? []).filter((s) => s.episode_count > 0 && s.season_number >= 0).map((s) => s.season_number);
  const chunks = await mapLimit(seasons, 4, async (n) => (await tmdbSeason(ctx, d.id, n))?.episodes ?? []);
  return chunks.flat().sort((a, b) => a.season_number - b.season_number || a.episode_number - b.episode_number);
}

export async function tmdbFind(ctx: Ctx, ids: IdBundle): Promise<IdBundle> {
  const out: IdBundle = { ...ids };
  if (!ctx.tmdbKey) return out;

  if (!out.tmdb && (out.imdb || out.tvdb)) {
    const [source, value] = out.imdb ? ['imdb_id', out.imdb] : ['tvdb_id', String(out.tvdb)];
    const found = await tmdbGet<{ movie_results?: TmdbListItem[]; tv_results?: TmdbListItem[]; tv_episode_results?: unknown[] }>(
      ctx, `/find/${encodeURIComponent(value)}`, { external_source: source }, TTL_FIND,
    );
    const movie = found?.movie_results?.[0];
    const tv = found?.tv_results?.[0];
    const pick = out.tmdbType === 'tv' ? tv ?? movie : out.tmdbType === 'movie' ? movie ?? tv : movie ?? tv;
    if (pick) {
      out.tmdb = pick.id;
      out.tmdbType = pick === tv ? 'tv' : 'movie';
    }
  }

  if (out.tmdb && (!out.imdb || (!out.tvdb && out.tmdbType !== 'movie'))) {
    const kinds: TmdbKind[] = out.tmdbType ? [out.tmdbType] : ['tv', 'movie'];
    for (const kind of kinds) {
      const d = await tmdbDetails(ctx, kind, out.tmdb);
      if (!d) continue;
      out.tmdbType = kind;
      const imdb = d.external_ids?.imdb_id || d.imdb_id;
      if (imdb && !out.imdb) out.imdb = imdb;
      if (d.external_ids?.tvdb_id && !out.tvdb) out.tvdb = d.external_ids.tvdb_id;
      break;
    }
  }
  return out;
}

function yearOf(date?: string): number | undefined {
  const y = date ? Number(date.slice(0, 4)) : NaN;
  return Number.isFinite(y) && y > 1800 ? y : undefined;
}

function contentTypeFor(kind: TmdbKind): ContentType {
  return kind === 'movie' ? 'movie' : 'series';
}

export async function tmdbGenres(ctx: Ctx, kind: TmdbKind): Promise<Map<number, string>> {
  const data = await tmdbGet<{ genres?: TmdbGenre[] }>(ctx, `/genre/${kind}/list`, { language: tmdbLanguage(ctx.cfg.language) }, 7 * 24 * 3600);
  return new Map<number, string>((data?.genres ?? []).map((g) => [g.id, g.name]));
}

export function previewFromListItem(item: TmdbListItem, kind: TmdbKind, genres?: Map<number, string>): MetaPreview {
  const date = kind === 'movie' ? item.release_date : item.first_air_date;
  const year = yearOf(date);
  return {
    id: `tmdb:${item.id}`,
    type: contentTypeFor(kind),
    name: (kind === 'movie' ? item.title : item.name) || item.title || item.name || '',
    poster: tmdbImageUrl(item.poster_path, 'w500'),
    background: tmdbImageUrl(item.backdrop_path, 'w1280'),
    description: item.overview || undefined,
    releaseInfo: year ? String(year) : undefined,
    year,
    imdbRating: item.vote_average ? item.vote_average.toFixed(1) : undefined,
    genres: genres ? (item.genre_ids ?? []).map((g) => genres.get(g)).filter((g): g is string => !!g) : undefined,
    posterShape: 'poster',
  };
}

export async function tmdbList(ctx: Ctx, kind: TmdbKind, path: string, params: Record<string, string>, page: number): Promise<MetaPreview[]> {
  const p = path.startsWith('/') ? path : `/${path}`;
  const data = await tmdbGet<TmdbPage<TmdbListItem>>(ctx, p, {
    language: tmdbLanguage(ctx.cfg.language),
    include_adult: ctx.cfg.search.includeAdult ? 'true' : 'false',
    ...params,
    page: Math.max(1, page || 1),
  }, TTL_LIST);
  if (!data?.results) return [];
  const genres = await tmdbGenres(ctx, kind);
  return data.results
    .filter((r) => !r.media_type || r.media_type === kind)
    .filter((r) => ctx.cfg.search.includeAdult || !r.adult)
    .map((r) => previewFromListItem(r, kind, genres));
}

export async function tmdbSearch(ctx: Ctx, kind: TmdbKind, query: string, page = 1): Promise<MetaPreview[]> {
  const q = query.trim();
  if (!q) return [];
  return tmdbList(ctx, kind, `/search/${kind}`, { query: q }, page);
}

function translated(d: TmdbDetails, lang: string, field: 'title' | 'overview' | 'tagline'): string | undefined {
  const list = d.translations?.translations ?? [];
  const isTitle = field === 'title';
  for (const l of [lang, 'en']) {
    const t = list.find((x) => x.iso_639_1 === l && x.data && (isTitle ? x.data.title || x.data.name : x.data[field]));
    if (t?.data) return isTitle ? t.data.title || t.data.name : t.data[field];
  }
  return undefined;
}

export function titleOf(d: TmdbDetails, lang: string): string {
  return d.title || d.name || translated(d, lang, 'title') || d.original_title || d.original_name || '';
}

export function overviewOf(d: TmdbDetails, lang: string): string | undefined {
  return d.overview || translated(d, lang, 'overview') || undefined;
}

export function certificationOf(d: TmdbDetails, region: string): string | undefined {
  const tryRegions = [region.toUpperCase(), 'US'];
  if (d.release_dates?.results) {
    const rows = d.release_dates.results;
    const find = (r: string) => rows.find((x) => x.iso_3166_1 === r)?.release_dates?.map((e) => e.certification?.trim()).find((c) => c);
    for (const r of tryRegions) { const c = find(r); if (c) return normalizeRating(c); }
    for (const row of rows) { const c = row.release_dates?.map((e) => e.certification?.trim()).find((x) => x); if (c) return normalizeRating(c); }
  }
  if (d.content_ratings?.results) {
    const rows = d.content_ratings.results;
    for (const r of tryRegions) { const c = rows.find((x) => x.iso_3166_1 === r)?.rating?.trim(); if (c) return normalizeRating(c); }
    const any = rows.find((x) => x.rating?.trim())?.rating;
    if (any) return normalizeRating(any);
  }
  return undefined;
}

export function runtimeText(minutes: number | null | undefined): string | undefined {
  return minutes && minutes > 0 ? `${Math.round(minutes)} min` : undefined;
}

export function trailersOf(d: TmdbDetails, lang: string): Array<{ source: string; type: 'Trailer' | 'Clip' }> {
  const vids = (d.videos?.results ?? []).filter((v) => v.site === 'YouTube' && v.key);
  const rank = (v: TmdbVideo) => (v.type === 'Trailer' ? 0 : v.type === 'Teaser' ? 1 : 2) * 10 + (v.iso_639_1 === lang ? 0 : v.iso_639_1 === 'en' ? 1 : 2) + (v.official ? 0 : 3);
  return vids
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 8)
    .map((v) => ({ source: v.key, type: v.type === 'Trailer' || v.type === 'Teaser' ? 'Trailer' : 'Clip' }));
}

export function searchLink(name: string, category: string): MetaLink {
  return { name, category, url: `stremio:///search?search=${encodeURIComponent(name)}` };
}

export function buildLinks(opts: { imdb?: string; tmdb?: number; kind: TmdbKind; rating?: string; genres?: string[]; cast?: string[]; director?: string[]; writer?: string[] }): MetaLink[] {
  const links: MetaLink[] = [];
  if (opts.imdb) links.push({ name: opts.rating || 'IMDb', category: 'imdb', url: `https://www.imdb.com/title/${opts.imdb}/` });
  if (opts.tmdb) links.push({ name: 'TMDB', category: 'tmdb', url: `https://www.themoviedb.org/${opts.kind}/${opts.tmdb}` });
  for (const g of opts.genres ?? []) links.push(searchLink(g, 'Genres'));
  for (const c of (opts.cast ?? []).slice(0, 10)) links.push(searchLink(c, 'Cast'));
  for (const c of opts.director ?? []) links.push(searchLink(c, 'Directors'));
  for (const c of opts.writer ?? []) links.push(searchLink(c, 'Writers'));
  return links;
}

export const ONGOING_STATUSES = new Set(['Returning Series', 'In Production', 'Planned', 'Pilot']);

function releaseInfoFor(d: TmdbDetails, kind: TmdbKind): string | undefined {
  if (kind === 'movie') return yearOf(d.release_date)?.toString();
  const start = yearOf(d.first_air_date);
  if (!start) return undefined;
  const ongoing = ONGOING_STATUSES.has(d.status || '') || d.in_production;
  const end = yearOf(d.last_air_date);
  if (ongoing) return `${start}-`;
  return end && end !== start ? `${start}-${end}` : String(start);
}

function crewNames(d: TmdbDetails, jobs: string[]): string[] {
  const out: string[] = [];
  for (const c of d.credits?.crew ?? []) if (c.job && jobs.includes(c.job) && !out.includes(c.name)) out.push(c.name);
  return out;
}

export function peopleFromDetails(d: TmdbDetails): MetaPerson[] {
  const credits = d.aggregate_credits ?? d.credits;
  const people: MetaPerson[] = (credits?.cast ?? []).slice()
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99)).slice(0, 30)
    .map(p => ({ name: p.name, type: 'Actor', tmdbId: p.id,
      role: p.character || [...new Set((p.roles ?? []).map(r => r.character).filter(Boolean))].join(' / ') || undefined,
      image: tmdbImageUrl(p.profile_path, 'w185') }));
  for (const p of credits?.crew ?? []) {
    const jobs = p.jobs?.map(j => j.job) ?? (p.job ? [p.job] : []);
    for (const type of ['Director', 'Writer'] as const) {
      const wanted = type === 'Director' ? ['Director', 'Series Director'] : ['Writer', 'Screenplay', 'Story', 'Novel', 'Author', 'Creator'];
      const roles = jobs.filter(job => wanted.includes(job));
      if (roles.length) people.push({ name: p.name, type, tmdbId: p.id, role: roles.join(' / '), image: tmdbImageUrl(p.profile_path, 'w185') });
    }
  }
  return [...new Map(people.filter(p => p.name).map(p => [`${p.type}:${p.tmdbId ?? p.name}`, p])).values()];
}

function episodeToVideo(canonicalId: string, ep: TmdbEpisode, fallbackThumb: string | undefined): MetaVideo {
  const released = ep.air_date ? toIsoNoon(ep.air_date) : undefined;
  const still = tmdbImageUrl(ep.still_path, 'w500');
  return {
    id: episodeId(canonicalId, ep.season_number, ep.episode_number),
    numbering: 'tmdb',
    title: ep.name || `Episode ${ep.episode_number}`,
    season: ep.season_number,
    episode: ep.episode_number,
    released,
    overview: ep.overview || undefined,
    thumbnail: still ?? fallbackThumb,
    rating: ep.vote_average ? ep.vote_average.toFixed(1) : undefined,
  };
}

export function toIsoNoon(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00.000Z` : new Date(date).toISOString();
}

export async function tmdbMeta(ctx: Ctx, kind: TmdbKind, tmdbId: number, canonicalId: string, opts: { withEpisodes?: boolean } = {}): Promise<Meta | null> {
  const d = await tmdbDetails(ctx, kind, tmdbId);
  if (!d) return null;
  const lang = splitLanguageTag(ctx.cfg.language).lang;
  const art = artworkFromDetails(d, lang);
  const imdb = d.external_ids?.imdb_id || d.imdb_id || undefined;
  const genres = (d.genres ?? []).map((g) => g.name);
  const cast = (d.credits?.cast ?? []).slice().sort((a, b) => (a.order ?? 99) - (b.order ?? 99)).slice(0, 15).map((c) => c.name);
  const director = kind === 'movie' ? crewNames(d, ['Director']) : crewNames(d, ['Director', 'Series Director']);
  const writer = crewNames(d, ['Writer', 'Screenplay', 'Story', 'Novel', 'Author', 'Creator']);
  const rating = d.vote_average ? d.vote_average.toFixed(1) : undefined;
  const certification = certificationOf(d, regionOf(ctx.cfg.language));
  const runtime = kind === 'movie' ? d.runtime : d.episode_run_time?.[0] ?? d.last_episode_to_air?.runtime ?? d.next_episode_to_air?.runtime;

  const meta: Meta = {
    id: canonicalId,
    type: contentTypeFor(kind),
    name: titleOf(d, lang),
    originalTitle: d.original_title || d.original_name,
    tagline: d.tagline || translated(d, lang, 'tagline'),
    studios: (d.production_companies ?? []).map(s => s.name),
    people: peopleFromDetails(d),
    description: overviewOf(d, lang),
    poster: art.poster,
    background: art.background,
    logo: art.logo,
    posterShape: 'poster',
    genres,
    releaseInfo: releaseInfoFor(d, kind),
    year: yearOf(kind === 'movie' ? d.release_date : d.first_air_date),
    released: (kind === 'movie' ? d.release_date : d.first_air_date) ? toIsoNoon((kind === 'movie' ? d.release_date : d.first_air_date)!) : undefined,
    imdbRating: rating,
    runtime: runtimeText(runtime),
    cast: cast.length ? cast : undefined,
    director: director.length ? director : undefined,
    writer: writer.length ? writer : undefined,
    country: d.production_countries?.[0]?.name || d.origin_country?.[0],
    language: d.spoken_languages?.[0]?.english_name || d.original_language,
    certification,
    status: d.status,
    network: d.networks?.[0]?.name,
    trailers: trailersOf(d, lang),
    links: buildLinks({ imdb, tmdb: d.id, kind, rating, genres, cast, director, writer }),
    ids: { imdb, tmdb: d.id, tvdb: d.external_ids?.tvdb_id ?? undefined },
    seasonPosters:Object.fromEntries((d.seasons??[]).filter(s=>s.poster_path).map(s=>[s.season_number,`https://image.tmdb.org/t/p/w500${s.poster_path}`])),
  };
  if (!meta.trailers?.length) delete meta.trailers;

  if (kind === 'movie') {
    meta.behaviorHints = { defaultVideoId: canonicalId, hasScheduledVideos: false };
    return meta;
  }

  const ongoing = ONGOING_STATUSES.has(d.status || '') || !!d.next_episode_to_air;
  if (opts.withEpisodes !== false) {
    const episodes = await tmdbAllEpisodes(ctx, d);
    meta.videos = episodes.map((ep) => episodeToVideo(canonicalId, ep, art.posterLandscape ?? art.background));
  }
  meta.behaviorHints = { defaultVideoId: null, hasScheduledVideos: ongoing };
  return meta;
}

export async function tmdbPreviewWithImdb(ctx: Ctx, preview: MetaPreview): Promise<MetaPreview> {
  const m = /^tmdb:(\d+)$/.exec(preview.id);
  if (!m) return preview;
  const kind: TmdbKind = preview.type === 'movie' ? 'movie' : 'tv';
  const d = await tmdbDetails(ctx, kind, Number(m[1]));
  const imdb = d?.external_ids?.imdb_id || d?.imdb_id;
  return imdb ? { ...preview, id: imdb } : preview;
}

import type { Ctx } from '../context';
import { metaAddons } from '../config/schema';
import type { ContentType, ManifestCatalog, MetaPreview } from '../stremio/types';
import { addonBase, addonCatalog, externalCatalogs } from '../stremio/client';
import { fetchJson, memo } from '../util/cache';
import { uniq } from '../util/concurrency';
import { trackerApi, catalogTrackers } from '../trackers/index';
import { tmdbList } from '../meta/tmdb';
import { malList } from '../meta/anime/mal';
import { anilistList } from '../meta/anime/anilist';
import { applyAgeCap, hasAgeCap } from './agecap';
import { mdbListInfo, mdbListPage, mdbTopLists, mdbUserLists } from './mdblist';
import { unifiedSearch } from './search';
import { sourceDefinitions, sourceItems } from './sources';
import { discoverItems } from './discovery';
import { mergedItems } from './merged';
import { recommendationItems } from './recommendations';
import { collectionsPage,collectionMembers } from './collections';
import { sameShow } from '../storage/dropped';
import { bundleFromStremioId } from '../meta/ids';
import type { Meta } from '../stremio/types';
import {
  AIRING_REGIONS, MAL_DECADES, MAL_GENRES, MAL_STUDIOS, STREAMING_PROVIDERS, TMDB_KEYWORDS, TMDB_LANGUAGES, TMDB_NETWORKS, WEEKDAYS,
  isoDate, parseSeasonLabel, recentSeasonLabels, regionOf, seasonOf, yearOptions,
} from './tables';

export type CatalogType = 'movie' | 'series' | 'anime';
export type CatalogNeed = 'tmdb' | 'tvdb' | 'mal' | 'anilist' | 'kitsu' | 'trakt' | 'simkl' | 'mdblist' | 'publicmetadb';

export interface CatalogDefinition {
  id: string;
  type: CatalogType;
  name: string;
  group: string;
  needs?: CatalogNeed[];
  extra?: ManifestCatalog['extra'];
  genres?: string[];
}

export interface CatalogExtra { search?: string; genre?: string; skip?: number }

const TMDB_PAGE = 20;
const JIKAN_PAGE = 25;
const ANILIST_PAGE = 20;
const TRAKT_PAGE = 20;
const TMDB_API = 'https://api.themoviedb.org/3';

const SKIP = { name: 'skip' } as const;
function genreExtra(options: string[], required = false): NonNullable<ManifestCatalog['extra']>[number] {
  return { name: 'genre', options, isRequired: required };
}
function withGenres(def: Omit<CatalogDefinition, 'extra' | 'genres'>, options: string[], required = false): CatalogDefinition {
  return { ...def, extra: [genreExtra(options, required), SKIP], genres: options };
}
function plain(def: Omit<CatalogDefinition, 'extra'>): CatalogDefinition {
  return { ...def, extra: [SKIP] };
}

function pageOf(skip: number | undefined, size: number): number {
  return Math.floor(Math.max(0, skip ?? 0) / size) + 1;
}

function satisfied(ctx: Ctx): Set<CatalogNeed> {
  const s = new Set<CatalogNeed>(['mal', 'anilist', 'kitsu']);
  const { keys, trackers } = ctx.cfg;
  if (ctx.tmdbKey) s.add('tmdb');
  if (keys.tvdb) s.add('tvdb');
  if (keys.mdblist) s.add('mdblist');
  if (keys.publicmetadb) s.add('publicmetadb');
  if (trackers.trakt?.clientId) s.add('trakt');
  if (trackers.simkl?.clientId) s.add('simkl');
  return s;
}

async function tmdbGenres(ctx: Ctx, kind: 'movie' | 'tv'): Promise<Array<{ id: number; name: string }>> {
  if (!ctx.tmdbKey) return [];
  const url = `${TMDB_API}/genre/${kind}/list?api_key=${ctx.tmdbKey}&language=${encodeURIComponent(ctx.cfg.language)}`;
  const data = await fetchJson<{ genres?: Array<{ id: number; name: string }> }>(url, { ttl: 30 * 24 * 3600 });
  return data?.genres ?? [];
}

function tmdbDefinitions(movieGenres: string[], tvGenres: string[], language: string): CatalogDefinition[] {
  const both = (kind: string, name: string, make: (type: CatalogType, genres: string[]) => CatalogDefinition): CatalogDefinition[] => [
    make('movie', movieGenres), make('series', tvGenres),
  ].map((d) => ({ ...d, id: `tmdb.${kind}`, name }));
  const region = regionOf(language);
  const G = 'TMDB';
  const T = (type: CatalogType, id: string, name: string): Omit<CatalogDefinition, 'extra' | 'genres'> => ({ id, type, name, group: G, needs: ['tmdb'] });
  const providerNames = STREAMING_PROVIDERS.map((p) => p.name);
  return [
    ...both('trending', 'Trending', (type) => withGenres(T(type, 'tmdb.trending', 'Trending'), ['Day', 'Week'])),
    ...both('popular', 'Popular', (type, g) => withGenres(T(type, 'tmdb.popular', 'Popular'), g)),
    ...both('top_rated', 'Top Rated', (type, g) => withGenres(T(type, 'tmdb.top_rated', 'Top Rated'), g)),
    plain(T('movie', 'tmdb.now_playing', `In Theaters (${region})`)),
    plain(T('movie', 'tmdb.upcoming', `Coming Soon (${region})`)),
    plain(T('series', 'tmdb.on_the_air', 'On The Air')),
    withGenres(T('series', 'tmdb.airing_today', 'Airing Today'), AIRING_REGIONS),
    ...both('genre', 'By Genre', (type, g) => withGenres(T(type, 'tmdb.genre', 'By Genre'), g, true)),
    withGenres(T('series', 'tmdb.network', 'By Network'), TMDB_NETWORKS.map((n) => n.name), true),
    ...both('keyword', 'By Keyword', (type) => withGenres(T(type, 'tmdb.keyword', 'By Keyword'), TMDB_KEYWORDS.map((k) => k.name), true)),
    ...both('year', 'By Year', (type) => withGenres(T(type, 'tmdb.year', 'By Year'), yearOptions())),
    ...both('language', 'By Language', (type) => withGenres(T(type, 'tmdb.language', 'By Language'), TMDB_LANGUAGES.map((l) => l.name))),
    ...both('streaming', 'Streaming On', (type) => withGenres(T(type, 'tmdb.streaming', 'Streaming On'), providerNames, true)),
  ];
}

function animeDefinitions(): CatalogDefinition[] {
  const M = (id: string, name: string): Omit<CatalogDefinition, 'extra'> => ({ id, type: 'anime', name, group: 'MyAnimeList' });
  const A = (id: string, name: string): Omit<CatalogDefinition, 'extra'> => ({ id, type: 'anime', name, group: 'AniList' });
  const seasons = recentSeasonLabels(12);
  return [
    plain(M('mal.airing', 'Airing Now')),
    plain(M('mal.top_anime', 'Top Anime')),
    plain(M('mal.top_series', 'Top Series')),
    plain(M('mal.top_movies', 'Top Movies')),
    plain(M('mal.most_popular', 'Most Popular')),
    plain(M('mal.most_favorites', 'Most Favorited')),
    plain(M('mal.upcoming', 'Upcoming')),
    withGenres(M('mal.seasons', 'By Season'), seasons),
    withGenres(M('mal.schedule', 'Weekly Schedule'), WEEKDAYS),
    withGenres(M('mal.genres', 'By Genre'), MAL_GENRES.map((g) => g.name), true),
    withGenres(M('mal.studios', 'By Studio'), MAL_STUDIOS.map((s) => s.name), true),
    withGenres(M('mal.decades', 'By Decade'), MAL_DECADES.map((d) => d.name)),
    plain(A('anilist.trending', 'Trending')),
    plain(A('anilist.popular', 'All-Time Popular')),
    withGenres(A('anilist.season', 'By Season'), seasons),
  ];
}

function searchDefinitions(): CatalogDefinition[] {
  return (['movie', 'series', 'anime'] as const).map((type) => ({
    id: 'rill.search', type, name: 'Search', group: 'Search',
    extra: [{ name: 'search', isRequired: true }, SKIP],
  }));
}

async function trackerDefinitions(ctx: Ctx): Promise<CatalogDefinition[]> {
  const groups=await Promise.all(catalogTrackers(ctx).map(async tracker => {
    if (!tracker.catalogs) return [];
    let cats:ManifestCatalog[]=[];
    try {cats=await tracker.catalogs(ctx);} catch {return [];}
    return cats.filter(c => ['movie','series','anime'].includes(c.type)).map(c => ({
      id:`tracker.${c.id}`,type:c.type as CatalogType,name:c.name,group:tracker.name,
      needs:[tracker.name],extra:c.extra?.length ? c.extra : [SKIP],genres:c.genres,
    }));
  }));
  return groups.flat();
}

function mdbTypes(mediatype: string | undefined): CatalogType[] {
  if (mediatype === 'movie') return ['movie'];
  if (mediatype === 'show') return ['series'];
  return ['movie', 'series'];
}

async function mdblistDefinitions(ctx: Ctx): Promise<CatalogDefinition[]> {
  if (!ctx.cfg.keys.mdblist) return [];
  const [mine, top] = await Promise.all([mdbUserLists(ctx), mdbTopLists(ctx)]);
  const out: CatalogDefinition[] = [];
  const seen = new Set<string>();
  const add = (ref: string, name: string, mediatype: string | undefined, group: string) => {
    for (const type of mdbTypes(mediatype)) {
      const k = `mdblist.${ref}|${type}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(plain({ id: `mdblist.${ref}`, type, name, group, needs: ['mdblist'] }));
    }
  };
  for (const l of mine) add(String(l.id), l.name, l.mediatype, 'MDBList: my lists');
  for (const ref of ctx.cfg.lists.mdblist) {
    const clean = ref.replace(/^mdblist\./, '').trim();
    if (!clean || seen.has(`mdblist.${clean}|movie`) || seen.has(`mdblist.${clean}|series`)) continue;
    const info = await mdbListInfo(ctx, clean);
    add(clean, info?.name || `MDBList ${clean}`, info?.mediatype, 'MDBList: my lists');
  }
  for (const l of top) add(String(l.id), `${l.name}${l.user_name ? ` (${l.user_name})` : ''}`, l.mediatype, 'MDBList: top lists');
  return out;
}

function publicTraktListPath(raw: string): string | null {
  const ref=raw.replace(/^trakt\.list\./,'').replace(/^https?:\/\/(?:www\.)?trakt\.tv\/users\//,'').replace('/lists/','/').replace(/\/$/,'');
  if (/^\d+$/.test(ref)) return `/lists/${ref}`;
  const match=/^([^/\s]+)\/([^/\s]+)$/.exec(ref);
  return match ? `/users/${encodeURIComponent(match[1])}/lists/${encodeURIComponent(match[2])}` : null;
}
interface TraktListInfo { name?: string; ids?: { trakt?: number; slug?: string } }

function traktHeaders(ctx: Ctx): Record<string, string> | null {
  const clientId = ctx.cfg.trackers.trakt?.clientId;
  if (!clientId) return null;
  return { 'content-type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': clientId };
}

async function traktListDefinitions(ctx: Ctx): Promise<CatalogDefinition[]> {
  const headers = traktHeaders(ctx);
  if (!headers || !ctx.cfg.lists.trakt.length) return [];
  const out: CatalogDefinition[] = [];
  for (const raw of ctx.cfg.lists.trakt) {
    const id = raw.replace(/^trakt\.list\./, '').trim();
    const path=publicTraktListPath(id);
    if (!path) continue;
    const info = await fetchJson<TraktListInfo>(`https://api.trakt.tv${path}`, { ttl: 24 * 3600, headers });
    const name = info?.name || `Trakt list ${id}`;
    for (const type of ['movie', 'series'] as const) out.push(plain({ id: `trakt.list.${id}`, type, name, group: 'Trakt lists', needs: ['trakt'] }));
  }
  return out;
}

async function addonDefinitions(ctx: Ctx): Promise<CatalogDefinition[]> {
  const urls = metaAddons(ctx.cfg);
  if (!urls.length) return [];
  const indexByBase = new Map<string, number>();
  urls.forEach((url, i) => { const b = addonBase(url); if (b && !indexByBase.has(b)) indexByBase.set(b, i); });
  let found: Awaited<ReturnType<typeof externalCatalogs>> = [];
  try { found = await externalCatalogs(ctx); } catch { found = []; }
  const out: CatalogDefinition[] = [];
  for (const { base, addonName, catalog } of found) {
    const n = indexByBase.get(base);
    if (n === undefined) continue;
    if (catalog.type !== 'movie' && catalog.type !== 'series' && catalog.type !== 'anime') continue;
    const extra = catalog.extra?.length
      ? catalog.extra
      : (catalog.extraSupported ?? []).map((name) => ({ name, isRequired: catalog.extraRequired?.includes(name) || false, options: name === 'genre' ? catalog.genres : undefined }));
    out.push({
      id: `addon.${n}.${catalog.id}`, type: catalog.type, name: `${catalog.name} (${addonName})`, group: addonName,
      extra: extra.length ? extra : [SKIP], genres: catalog.genres,
    });
  }
  return out;
}

export async function listCatalogDefinitions(ctx: Ctx): Promise<CatalogDefinition[]> {
  return memo(`catalog-defs:v6:${ctx.scope}:${ctx.cacheRevision ?? ctx.cfgToken}`, 600, async () => {
    if (!ctx.cfg.advanced) return [...await addonDefinitions(ctx), ...searchDefinitions()];
    const have = satisfied(ctx);
    const [movieGenres, tvGenres, tracker, mdb, trakt, addons, sources] = await Promise.all([
      tmdbGenres(ctx, 'movie'), tmdbGenres(ctx, 'tv'), trackerDefinitions(ctx), mdblistDefinitions(ctx), traktListDefinitions(ctx), addonDefinitions(ctx),
      sourceDefinitions(ctx),
    ]);
    const all: CatalogDefinition[] = [
      ...addons,
      ...searchDefinitions(),
      ...tracker,
      ...tmdbDefinitions(movieGenres.map((g) => g.name), tvGenres.map((g) => g.name), ctx.cfg.language),
      ...animeDefinitions(),
      ...mdb,
      ...trakt,
      ...sources,
      ...(ctx.cfg.recommendations?.enabled&&ctx.cfg.recommendations.apiKey&&ctx.cfg.recommendations.model&&ctx.tmdbKey?(['movie','series','anime'] as const).map(type=>({id:`recommendations.${type}`,type,name:type==='movie'?'Films For You':type==='series'?'Series For You':'Anime For You',group:'Recommendations',extra:[SKIP]})):[]),
    ];
    const simple = !ctx.cfg.advanced;
    const keyedSources = new Set<CatalogNeed>(['tmdb', 'tvdb', 'trakt', 'simkl', 'mdblist', 'publicmetadb']);
    return all.filter((d) => {
      const source = catalogSource(d).id;
      if (keyedSources.has(source as CatalogNeed) && !have.has(source as CatalogNeed)) return false;
      if (source === 'movielens' && (!ctx.cfg.movieLens?.username || !ctx.cfg.movieLens.password)) return false;
      return (d.needs ?? []).every((n) => have.has(n)) && (!simple || ['rill', 'addon'].includes(d.id.split('.')[0]));
    });
  });
}

export function defaultCatalogEnabled(def: CatalogDefinition): boolean {
  return def.id.startsWith('addon.');
}

export function catalogSource(def: CatalogDefinition): { id: string; name: string } {
  const [head, detail] = def.id.split('.');
  if (head === 'addon') return { id: `addon.${detail}`, name: def.group };
  const id = head === 'tracker' ? detail.split(':')[0] : head;
  const names: Record<string, string> = {
    tmdb: 'TMDB', tvdb: 'TVDB', tvmaze: 'TVmaze', mal: 'MyAnimeList', anilist: 'AniList',
    kitsu: 'Kitsu', trakt: 'Trakt', simkl: 'Simkl', mdblist: 'MDBList', publicmetadb: 'PublicMetaDB',
    letterboxd: 'Letterboxd', movielens: 'MovieLens', flixpatrol: 'FlixPatrol',
    rill: 'Search', merged: 'Merged catalogs', recommendations: 'Recommendations',
  };
  return { id, name: names[id] || def.group };
}

export async function enabledCatalogDefinitions(ctx: Ctx): Promise<CatalogDefinition[]> {
  const toggles = ctx.cfg.catalogs;
  // Browsing add-on catalogs does not require discovering every connected
  // tracker's lists. The settings page still discovers all available catalogs.
  const addonOnly = toggles.filter(t => t.enabled).every(t => t.id.startsWith('addon.') || t.id === 'rill.search');
  const all = addonOnly
    ? await memo(`addon-catalog-defs:v1:${ctx.scope}:${ctx.cacheRevision ?? ctx.cfgToken}`, 600,
      async () => [...await addonDefinitions(ctx), ...searchDefinitions()])
    : await listCatalogDefinitions(ctx);
  if (!toggles.length) return all.filter(defaultCatalogEnabled);
  const byKey = new Map(all.map((d) => [`${d.type}|${d.id}`, d]));
  const out: CatalogDefinition[] = [];
  for (const t of toggles) {
    if (!t.enabled) continue;
    const def = byKey.get(`${t.type}|${t.id}`);
    if (!def) continue;
    out.push(t.name?.trim() ? { ...def, name: t.name.trim() } : def);
  }
  return out.sort((a, b) => Number(b.id.startsWith('addon.')) - Number(a.id.startsWith('addon.')));
}

function cleanGenre(extra: CatalogExtra): string | undefined {
  const g = extra.genre?.trim();
  return g && g.toLowerCase() !== 'none' ? g : undefined;
}

function wantsSfw(ctx: Ctx): boolean {
  return hasAgeCap(ctx) || !ctx.cfg.search.includeAdult;
}

async function tmdbItems(ctx: Ctx, type: ContentType, kind: string, extra: CatalogExtra): Promise<MetaPreview[]> {
  if (!ctx.tmdbKey) return [];
  const k: 'movie' | 'tv' = type === 'movie' ? 'movie' : 'tv';
  const page = pageOf(extra.skip, TMDB_PAGE);
  const genre = cleanGenre(extra);
  const language = ctx.cfg.language;
  const region = regionOf(language);
  const p: Record<string, string> = { language, include_adult: ctx.cfg.search.includeAdult ? 'true' : 'false' };
  const discover = `/discover/${k}`;
  const genreId = async () => {
    if (!genre) return undefined;
    const hit = (await tmdbGenres(ctx, k)).find((g) => g.name.toLowerCase() === genre.toLowerCase());
    return hit ? String(hit.id) : undefined;
  };
  switch (kind) {
    case 'trending':
      return tmdbList(ctx, k, `/trending/${k}/${genre?.toLowerCase() === 'week' ? 'week' : 'day'}`, { language }, page);
    case 'popular': {
      p.sort_by = 'popularity.desc';
      const g = await genreId(); if (g) p.with_genres = g;
      if (k === 'tv') { p.watch_region = region; p.with_watch_monetization_types = 'flatrate|free|ads|rent|buy'; }
      return tmdbList(ctx, k, discover, p, page);
    }
    case 'top_rated': {
      p.sort_by = 'vote_average.desc'; p['vote_count.gte'] = k === 'movie' ? '500' : '200'; p.without_genres = '99,10755';
      const g = await genreId(); if (g) p.with_genres = g;
      return tmdbList(ctx, k, discover, p, page);
    }
    case 'now_playing': return k === 'movie' ? tmdbList(ctx, k, '/movie/now_playing', { language, region }, page) : [];
    case 'upcoming': return k === 'movie' ? tmdbList(ctx, k, '/movie/upcoming', { language, region }, page) : [];
    case 'on_the_air': return k === 'tv' ? tmdbList(ctx, k, '/tv/on_the_air', { language }, page) : [];
    case 'airing_today': {
      if (k !== 'tv') return [];
      const today = isoDate(new Date());
      p['air_date.gte'] = today; p['air_date.lte'] = today; p.sort_by = 'popularity.desc';
      if (genre) p.with_origin_country = genre.toUpperCase();
      return tmdbList(ctx, k, discover, p, page);
    }
    case 'genre': {
      const g = await genreId();
      if (!g) return [];
      p.with_genres = g; p.sort_by = 'popularity.desc';
      return tmdbList(ctx, k, discover, p, page);
    }
    case 'network': {
      const n = TMDB_NETWORKS.find((x) => x.name.toLowerCase() === genre?.toLowerCase());
      if (!n || k !== 'tv') return [];
      p.with_networks = String(n.id); p.sort_by = 'popularity.desc';
      return tmdbList(ctx, k, discover, p, page);
    }
    case 'keyword': {
      const kw = TMDB_KEYWORDS.find((x) => x.name.toLowerCase() === genre?.toLowerCase());
      if (!kw) return [];
      p.with_keywords = String(kw.id); p.sort_by = 'popularity.desc';
      return tmdbList(ctx, k, discover, p, page);
    }
    case 'year': {
      const sel = genre ?? String(new Date().getUTCFullYear());
      const dateField = k === 'movie' ? 'primary_release_date' : 'first_air_date';
      const decade = /^(\d{4})s$/.exec(sel);
      if (decade) { p[`${dateField}.gte`] = `${decade[1]}-01-01`; p[`${dateField}.lte`] = `${Number(decade[1]) + 9}-12-31`; }
      else p[k === 'movie' ? 'primary_release_year' : 'first_air_date_year'] = sel;
      p.sort_by = 'popularity.desc'; p['vote_count.gte'] = '20';
      return tmdbList(ctx, k, discover, p, page);
    }
    case 'language': {
      const code = genre ? TMDB_LANGUAGES.find((l) => l.name.toLowerCase() === genre.toLowerCase())?.code : language.split('-')[0];
      if (!code) return [];
      p.with_original_language = code; p.sort_by = 'popularity.desc';
      return tmdbList(ctx, k, discover, p, page);
    }
    case 'streaming': {
      const prov = STREAMING_PROVIDERS.find((x) => x.name.toLowerCase() === genre?.toLowerCase());
      if (!prov) return [];
      p.with_watch_providers = String(prov.id);
      p.watch_region = region === 'US' ? prov.region : region;
      p.with_watch_monetization_types = 'flatrate|free|ads';
      p.sort_by = 'popularity.desc';
      return tmdbList(ctx, k, discover, p, page);
    }
    default: return [];
  }
}

async function malItems(ctx: Ctx, kind: string, extra: CatalogExtra): Promise<MetaPreview[]> {
  const page = pageOf(extra.skip, JIKAN_PAGE);
  const genre = cleanGenre(extra);
  const sfw: Record<string, string> = wantsSfw(ctx) ? { sfw: 'true' } : {};
  switch (kind) {
    case 'top_anime': return malList(ctx, 'top', { ...sfw }, page);
    case 'top_series': return malList(ctx, 'top', { type: 'tv', ...sfw }, page);
    case 'top_movies': return malList(ctx, 'top', { type: 'movie', ...sfw }, page);
    case 'most_popular': return malList(ctx, 'top', { filter: 'bypopularity', ...sfw }, page);
    case 'most_favorites': return malList(ctx, 'top', { filter: 'favorite', ...sfw }, page);
    case 'airing': return malList(ctx, 'season', { season: 'now', ...sfw }, page);
    case 'upcoming': return malList(ctx, 'season', { season: 'upcoming', ...sfw }, page);
    case 'seasons': {
      const sel = parseSeasonLabel(genre) ?? seasonOf(new Date());
      return malList(ctx, 'season', { season: `${sel.season} ${sel.year}`, ...sfw }, page);
    }
    case 'schedule': {
      const day = WEEKDAYS.find((d) => d.toLowerCase() === genre?.toLowerCase()) ?? WEEKDAYS[(new Date().getUTCDay() + 6) % 7];
      return malList(ctx, 'schedule', { day: day.toLowerCase(), ...sfw }, page);
    }
    case 'genres': {
      const g = MAL_GENRES.find((x) => x.name.toLowerCase() === genre?.toLowerCase());
      if (!g) return [];
      return malList(ctx, 'genre', { id: String(g.id), ...sfw }, page);
    }
    case 'studios': {
      const s = MAL_STUDIOS.find((x) => x.name.toLowerCase() === genre?.toLowerCase());
      if (!s) return [];
      return malList(ctx, 'studio', { id: String(s.id), ...sfw }, page);
    }
    case 'decades': {
      const d = MAL_DECADES.find((x) => x.name === genre) ?? MAL_DECADES[0];
      return malList(ctx, 'decade', { decade: d.from.slice(0, 4), ...sfw }, page);
    }
    default: return [];
  }
}

async function anilistItems(ctx: Ctx, kind: string, extra: CatalogExtra): Promise<MetaPreview[]> {
  const page = pageOf(extra.skip, ANILIST_PAGE);
  const base: Record<string, string> = { perPage: String(ANILIST_PAGE) };
  if (wantsSfw(ctx)) base.isAdult = 'false';
  switch (kind) {
    case 'trending': return anilistList(ctx, 'trending', base, page);
    case 'popular': return anilistList(ctx, 'popular', base, page);
    case 'season': {
      const sel = parseSeasonLabel(cleanGenre(extra)) ?? seasonOf(new Date());
      return anilistList(ctx, 'season', { ...base, season: `${sel.season} ${sel.year}` }, page);
    }
    default: return [];
  }
}

interface TraktListItem {
  type?: string;
  movie?: TraktEntity;
  show?: TraktEntity;
}
interface TraktEntity { title?: string; year?: number; overview?: string; rating?: number; genres?: string[]; ids?: { imdb?: string; tmdb?: number; tvdb?: number } }

async function traktListItems(ctx: Ctx, type: ContentType, listId: string, extra: CatalogExtra): Promise<MetaPreview[]> {
  const headers = traktHeaders(ctx);
  if (!headers || (type !== 'movie' && type !== 'series')) return [];
  const page = pageOf(extra.skip, TRAKT_PAGE);
  const kind = type === 'movie' ? 'movies' : 'shows';
  const path=publicTraktListPath(listId);
  if (!path) return [];
  const url = `https://api.trakt.tv${path}/items/${kind}?extended=full&page=${page}&limit=${TRAKT_PAGE}`;
  const rows = await fetchJson<TraktListItem[]>(url, { ttl: 900, headers });
  const out: MetaPreview[] = [];
  for (const row of rows ?? []) {
    const e = type === 'movie' ? row.movie : row.show;
    if (!e?.title) continue;
    const id = e.ids?.imdb && /^tt\d+$/.test(e.ids.imdb) ? e.ids.imdb : e.ids?.tmdb ? `tmdb:${e.ids.tmdb}` : e.ids?.tvdb ? `tvdb:${e.ids.tvdb}` : undefined;
    if (!id) continue;
    const m: MetaPreview = { id, type, name: e.title };
    if (e.year) { m.year = e.year; m.releaseInfo = String(e.year); }
    if (e.overview) m.description = e.overview;
    if (typeof e.rating === 'number' && e.rating > 0) m.imdbRating = e.rating.toFixed(1);
    if (e.genres?.length) m.genres = e.genres.map((g) => g.replace(/(^|-)(\w)/g, (_, d: string, c: string) => `${d === '-' ? ' ' : ''}${c.toUpperCase()}`));
    out.push(m);
  }
  return out;
}

async function addonItems(ctx: Ctx, type: ContentType, rest: string, extra: CatalogExtra): Promise<MetaPreview[]> {
  const dot = rest.indexOf('.');
  if (dot <= 0) return [];
  const n = Number(rest.slice(0, dot));
  const catalogId = rest.slice(dot + 1);
  const url = metaAddons(ctx.cfg)[n];
  const base = url ? addonBase(url) : null;
  if (!base) return [];
  return addonCatalog(base, type, catalogId, { search: extra.search, genre: cleanGenre(extra), skip: extra.skip });
}

async function trackerItems(ctx: Ctx, catalogId: string, extra: CatalogExtra): Promise<MetaPreview[]> {
  const tracker = catalogTrackers(ctx).find(t => catalogId.startsWith(t.name+':'));
  if (!tracker?.catalogItems) return [];
  return tracker.catalogItems(ctx, catalogId, extra.skip ?? 0);
}

export async function catalogPage(ctx: Ctx, type: ContentType, id: string, extra: CatalogExtra = {}): Promise<{ items: MetaPreview[]; consumed: number }> {
  if(id==='tvdb.collections')return collectionsPage(ctx,Math.max(0,extra.skip??0));
  if(/^tmdb\.collection\.\d+$/.test(id)) {
    const page=await collectionMembers(ctx,`tmdbc:${id.split('.')[2]}`,Math.max(0,extra.skip??0));
    return{items:await applyAgeCap(ctx,'movie',page.items),consumed:page.items.length};
  }
  const dot = id.indexOf('.');
  const head = dot > 0 ? id.slice(0, dot) : id;
  const rest = dot > 0 ? id.slice(dot + 1) : '';

  let items: MetaPreview[];
  const custom=ctx.cfg.customCatalogs?.find(c=>c.type===type && id===`${c.provider}.custom.${c.id}`);
  if(head==='recommendations'&&['movie','series','anime'].includes(rest)) {
    items=await recommendationItems(ctx,rest as 'movie'|'series'|'anime',extra.skip??0);
  } else if(custom?.provider==='merged') {
    items=await mergedItems(custom.sources??[],Math.max(0,extra.skip??0),20,async(source,skip)=>catalogPage(ctx,source.type,source.id,{...extra,skip,genre:source.genre||extra.genre}));
  } else if(custom && custom.provider!=='movielens') {
    items=await discoverItems(ctx,custom,extra);
  } else if (['tvdb','tvmaze','simkl','letterboxd','movielens','flixpatrol'].includes(head)||head==='trakt'&&!rest.startsWith('list.')) {
    items=await sourceItems(ctx,type,id,extra)??[];
  } else if (head === 'rill' && rest === 'search') {
    items = extra.search ? await unifiedSearch(ctx, type, extra.search, extra.skip ?? 0) : [];
  } else if (head === 'addon') {
    items = await addonItems(ctx, type, rest, extra);
  } else if (extra.search) {
    items = await unifiedSearch(ctx, type, extra.search, extra.skip ?? 0);
  } else if (head === 'tmdb') {
    items = await tmdbItems(ctx, type, rest, extra);
  } else if (head === 'cinemeta') {
    items = [];
  } else if (head === 'mal') {
    items = await malItems(ctx, rest, extra);
  } else if (head === 'anilist') {
    items = await anilistItems(ctx, rest, extra);
  } else if (head === 'mdblist') {
    items = await mdbListPage(ctx, rest, type, extra.skip ?? 0);
  } else if (head === 'trakt' && rest.startsWith('list.')) {
    items = await traktListItems(ctx, type, rest.slice(5), extra);
  } else if (head === 'tracker') {
    items = await trackerItems(ctx, rest, extra);
  } else {
    items = [];
  }

  let clean = uniq(items.filter((m) => m && m.id && m.name), (m) => m.id);
  if (head === 'tracker' && type !== 'movie' && /^(publicmetadb:(series|anime):resume|simkl:watching:(series|anime)|mal:watching|anilist:(current|repeating))$/.test(rest)) {
    const dropped = (await trackerApi.snapshot(ctx)).dropped ?? [];
    clean = clean.filter(meta => !dropped.some(ids => sameShow(ids, { ...bundleFromStremioId(meta.id), ...(meta as Meta).ids })));
  }
  return { items: await applyAgeCap(ctx, type, clean), consumed: items.length };
}

export async function catalogItems(ctx: Ctx, type: ContentType, id: string, extra: CatalogExtra = {}): Promise<MetaPreview[]> {
  return (await catalogPage(ctx, type, id, extra)).items;
}

import type { Ctx } from '../../context';
import type { IdBundle } from '../types';
import { memo, fetchJson } from '../../util/cache';
import { tmdbFind } from '../tmdb';
import { anilistIdsFor } from './anilist';
import { kitsuExternalIds, kitsuLookupByExternal } from './kitsu';
import { malExternalIds } from './mal';
import { animeKind, type AnimeKind } from './shared';

const FRIBB_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/refs/heads/master/anime-list-mini.json';
const INDEX_KEY = 'anime:fribb:index:v1';
const INDEX_TTL = 24 * 3600;

export type MappingRow = [number, number, number, number, string | string[] | 0, number, number, KindCode, TmdbKind, number];
type KindCode = 'T' | 'M' | 'O' | 'N' | 'S' | 'U';
type TmdbKind = 0 | 1 | 2;

const enum Col { Mal = 0, Anilist = 1, Kitsu = 2, Anidb = 3, Imdb = 4, Tmdb = 5, Tvdb = 6, Kind = 7, TmdbKind = 8, TvdbSeason = 9 }

interface FribbEntry {
  type?: string;
  mal_id?: number;
  anilist_id?: number;
  kitsu_id?: number;
  anidb_id?: number;
  imdb_id?: string | string[];
  themoviedb_id?: number | number[] | { tv?: number | number[]; movie?: number | number[] } | null;
  tvdb_id?: number;
  season?: { tvdb?: number; tmdb?: number } | null;
}

export interface AnimeMapping extends IdBundle {
  kind: AnimeKind;
  tvdbSeason?: number;
  imdbAll: string[];
}

function kindCode(type: string | undefined): KindCode {
  switch (animeKind(type)) {
    case 'TV': return 'T';
    case 'MOVIE': return 'M';
    case 'OVA': return 'O';
    case 'ONA': return 'N';
    case 'SPECIAL': return 'S';
    default: return 'U';
  }
}

function kindFromCode(code: KindCode): AnimeKind {
  switch (code) {
    case 'T': return 'TV';
    case 'M': return 'MOVIE';
    case 'O': return 'OVA';
    case 'N': return 'ONA';
    case 'S': return 'SPECIAL';
    default: return 'UNKNOWN';
  }
}

function firstNumber(v: number | number[] | undefined): number {
  if (Array.isArray(v)) return Number(v[0]) || 0;
  return Number(v) || 0;
}

function squash(entries: FribbEntry[]): MappingRow[] {
  const rows: MappingRow[] = [];
  for (const e of entries) {
    const mal = Number(e.mal_id) || 0;
    const anilist = Number(e.anilist_id) || 0;
    const kitsu = Number(e.kitsu_id) || 0;
    const anidb = Number(e.anidb_id) || 0;
    if (!mal && !anilist && !kitsu && !anidb) continue;
    let tmdb = 0;
    let tmdbKind: TmdbKind = 0;
    const t = e.themoviedb_id;
    if (t && typeof t === 'object' && !Array.isArray(t)) {
      if (t.tv) { tmdb = firstNumber(t.tv); tmdbKind = 1; }
      else if (t.movie) { tmdb = firstNumber(t.movie); tmdbKind = 2; }
    } else if (t) {
      tmdb = firstNumber(t as number | number[]);
      tmdbKind = animeKind(e.type) === 'MOVIE' ? 2 : 1;
    }
    const imdbList = (Array.isArray(e.imdb_id) ? e.imdb_id : e.imdb_id ? [e.imdb_id] : []).filter((s) => /^tt\d+$/.test(String(s)));
    const imdb: string | string[] | 0 = imdbList.length === 0 ? 0 : imdbList.length === 1 ? imdbList[0] : imdbList;
    const tvdbSeason = e.season && typeof e.season.tvdb === 'number' ? e.season.tvdb : -1;
    rows.push([mal, anilist, kitsu, anidb, imdb, tmdb, Number(e.tvdb_id) || 0, kindCode(e.type), tmdbKind, tvdbSeason]);
  }
  return rows;
}

async function downloadIndex(): Promise<MappingRow[]> {
  const raw = await fetchJson<FribbEntry[]>(FRIBB_URL, { ttl: 0, timeoutMs: 45000 });
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('anime-lists download failed');
  return squash(raw);
}

const perRequest = new WeakMap<object, Promise<MappingRow[]>>();

export function loadMappingIndex(ctx?: Ctx): Promise<MappingRow[]> {
  const load = () => memo(INDEX_KEY, INDEX_TTL, downloadIndex).catch(() => [] as MappingRow[]);
  if (!ctx) return load();
  let p = perRequest.get(ctx);
  if (!p) { p = load(); perRequest.set(ctx, p); }
  return p;
}

export function unpackRow(row: MappingRow): AnimeMapping {
  const imdbAll = row[Col.Imdb] === 0 ? [] : Array.isArray(row[Col.Imdb]) ? (row[Col.Imdb] as string[]) : [row[Col.Imdb] as string];
  const out: AnimeMapping = { kind: kindFromCode(row[Col.Kind]), imdbAll };
  if (row[Col.Mal]) out.mal = row[Col.Mal];
  if (row[Col.Anilist]) out.anilist = row[Col.Anilist];
  if (row[Col.Kitsu]) out.kitsu = row[Col.Kitsu];
  if (row[Col.Anidb]) out.anidb = row[Col.Anidb];
  if (imdbAll[0]) out.imdb = imdbAll[0];
  if (row[Col.Tmdb]) { out.tmdb = row[Col.Tmdb]; out.tmdbType = row[Col.TmdbKind] === 2 ? 'movie' : 'tv'; }
  if (row[Col.Tvdb]) out.tvdb = row[Col.Tvdb];
  if (row[Col.TvdbSeason] >= 0) out.tvdbSeason = row[Col.TvdbSeason];
  return out;
}

function rowHasImdb(row: MappingRow, imdb: string): boolean {
  const v = row[Col.Imdb];
  return v === imdb || (Array.isArray(v) && v.includes(imdb));
}

export async function mappingsForExternal(ctx: Ctx | undefined, ids: IdBundle): Promise<AnimeMapping[]> {
  const rows = await loadMappingIndex(ctx);
  const hits: MappingRow[] = [];
  for (const row of rows) {
    if (ids.imdb && rowHasImdb(row, ids.imdb)) { hits.push(row); continue; }
    if (ids.tvdb && row[Col.Tvdb] === ids.tvdb) { hits.push(row); continue; }
    if (ids.tmdb && row[Col.Tmdb] === ids.tmdb) {
      const wantMovie = ids.tmdbType === 'movie';
      const kindOk = ids.tmdbType ? (row[Col.TmdbKind] === (wantMovie ? 2 : 1)) : true;
      if (kindOk) hits.push(row);
    }
  }
  return hits.map(unpackRow);
}

export async function mappingForAnimeId(ctx: Ctx | undefined, ids: IdBundle): Promise<AnimeMapping | null> {
  if (!ids.mal && !ids.anilist && !ids.kitsu && !ids.anidb) return null;
  const rows = await loadMappingIndex(ctx);
  let best: MappingRow | null = null;
  let bestScore = 0;
  for (const row of rows) {
    let score = 0;
    if (ids.mal && row[Col.Mal] === ids.mal) score++;
    if (ids.anilist && row[Col.Anilist] === ids.anilist) score++;
    if (ids.kitsu && row[Col.Kitsu] === ids.kitsu) score++;
    if (ids.anidb && row[Col.Anidb] === ids.anidb) score++;
    if (score > bestScore) { best = row; bestScore = score; }
  }
  return best ? unpackRow(best) : null;
}

const KIND_RANK: Record<AnimeKind, number> = { TV: 0, ONA: 1, MOVIE: 2, OVA: 3, SPECIAL: 4, MUSIC: 5, UNKNOWN: 6 };

export function sortFranchise(rows: AnimeMapping[]): AnimeMapping[] {
  return [...rows].sort((a, b) => {
    const sa = a.tvdbSeason === undefined ? 1e6 : a.tvdbSeason === 0 ? 1e5 : a.tvdbSeason;
    const sb = b.tvdbSeason === undefined ? 1e6 : b.tvdbSeason === 0 ? 1e5 : b.tvdbSeason;
    if (sa !== sb) return sa - sb;
    if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
    return (a.mal || a.anilist || 1e9) - (b.mal || b.anilist || 1e9);
  });
}

export function pickRepresentative(rows: AnimeMapping[], wantMovie: boolean | undefined): AnimeMapping | null {
  if (rows.length === 0) return null;
  if (wantMovie === true) return rows.find((r) => r.kind === 'MOVIE') || rows[0];
  const sorted = sortFranchise(rows.filter((r) => wantMovie === false ? r.kind !== 'MOVIE' : true));
  return sorted[0] || rows[0];
}

function fill(target: IdBundle, from: Partial<IdBundle> | null | undefined): void {
  if (!from) return;
  for (const k of ['imdb', 'tmdb', 'tvdb', 'mal', 'anilist', 'kitsu', 'anidb', 'tmdbType'] as const) {
    if (target[k] === undefined && from[k] !== undefined && from[k] !== null) (target as Record<string, unknown>)[k] = from[k];
  }
}

function hasAnimeId(ids: IdBundle): boolean {
  return Boolean(ids.mal || ids.anilist || ids.kitsu || ids.anidb);
}

export async function mapAnimeIds(ctx: Ctx, input: IdBundle): Promise<IdBundle> {
  const ids: IdBundle = { ...input };

  let row = await mappingForAnimeId(ctx, ids);
  if (row) fill(ids, row);

  if (!row && (ids.imdb || ids.tmdb || ids.tvdb)) {
    const rows = await mappingsForExternal(ctx, ids);
    row = pickRepresentative(rows, ids.tmdbType ? ids.tmdbType === 'movie' : undefined);
    if (row) fill(ids, row);
  }

  if (!hasAnimeId(ids)) return ids;
  if (ids.kitsu && (!ids.mal || !ids.anilist || !ids.anidb)) {
    fill(ids, await kitsuExternalIds(ctx, ids.kitsu));
  } else if (!ids.kitsu) {
    const site = ids.mal ? 'myanimelist/anime' : ids.anilist ? 'anilist/anime' : ids.anidb ? 'anidb' : null;
    const ext = ids.mal || ids.anilist || ids.anidb;
    if (site && ext) {
      const kitsuId = await kitsuLookupByExternal(ctx, site, ext);
      if (kitsuId) {
        ids.kitsu = kitsuId;
        fill(ids, await kitsuExternalIds(ctx, kitsuId));
      }
    }
  }

  if ((ids.mal && !ids.anilist) || (ids.anilist && !ids.mal)) {
    fill(ids, await anilistIdsFor(ctx, { mal: ids.mal, anilist: ids.anilist }));
  }

  if (ids.mal && (!ids.anidb || !ids.anilist || !ids.kitsu)) {
    fill(ids, await malExternalIds(ctx, ids.mal));
  }

  if (!row && hasAnimeId(ids)) {
    row = await mappingForAnimeId(ctx, ids);
    if (row) fill(ids, row);
  }

  if ((ids.imdb && !ids.tmdb) || (ids.tmdb && !ids.imdb) || (ids.tvdb && !ids.tmdb)) {
    try {
      fill(ids, await tmdbFind(ctx, ids));
    } catch {
    }
  }
  return ids;
}

export async function isKnownAnime(ids: IdBundle): Promise<boolean> {
  if (hasAnimeId(ids)) return true;
  if (!ids.imdb && !ids.tmdb && !ids.tvdb) return false;
  const rows = await mappingsForExternal(undefined, ids);
  return rows.length > 0;
}

import type { Ctx } from '../context';
import type { ContentType, MetaPreview } from '../stremio/types';
import { fetchJson } from '../util/cache';

const API = 'https://api.mdblist.com';
export const MDBLIST_PAGE_SIZE = 20;
const LIST_TTL = 1800;
const ITEMS_TTL = 900;

export interface MdbListSummary {
  id: number;
  name: string;
  slug?: string;
  user_name?: string;
  mediatype?: string;
  items?: number;
  likes?: number;
  dynamic?: boolean;
  private?: boolean;
}

interface MdbListItem {
  id?: number;
  tmdb_id?: number;
  imdb_id?: string | null;
  tvdb_id?: number | null;
  title?: string;
  rank?: number;
  mediatype?: 'movie' | 'show' | string;
  release_year?: number | null;
  poster?: string | null;
  genre?: string[] | null;
  score?: number | null;
}

interface MdbItemsPayload { movies?: MdbListItem[]; shows?: MdbListItem[] }

function key(ctx: Ctx): string | undefined {
  return ctx.cfg.keys.mdblist?.trim() || undefined;
}

function scoped(ctx: Ctx): string {
  return `mdblist:${ctx.scope}`;
}

export async function mdbUserLists(ctx: Ctx): Promise<MdbListSummary[]> {
  const k = key(ctx);
  if (!k) return [];
  const data = await fetchJson<MdbListSummary[]>(`${API}/lists/user?apikey=${encodeURIComponent(k)}`, { ttl: LIST_TTL, cacheScope: scoped(ctx) });
  return Array.isArray(data) ? data.filter((l) => l && typeof l.id === 'number' && l.name) : [];
}

export async function mdbTopLists(ctx: Ctx): Promise<MdbListSummary[]> {
  const k = key(ctx);
  if (!k) return [];
  const data = await fetchJson<MdbListSummary[]>(`${API}/lists/top?apikey=${encodeURIComponent(k)}`, { ttl: 6 * 3600, cacheScope: scoped(ctx) });
  return Array.isArray(data) ? data.filter((l) => l && typeof l.id === 'number' && l.name) : [];
}

export async function mdbListInfo(ctx: Ctx, ref: string): Promise<MdbListSummary | null> {
  const k = key(ctx);
  if (!k) return null;
  const path = /^\d+$/.test(ref) ? `lists/${ref}` : `lists/${ref.split('/').map(encodeURIComponent).join('/')}`;
  const data = await fetchJson<MdbListSummary[] | MdbListSummary>(`${API}/${path}?apikey=${encodeURIComponent(k)}`, { ttl: 24 * 3600, cacheScope: scoped(ctx) });
  const one = Array.isArray(data) ? data[0] : data;
  return one && typeof one.id === 'number' ? one : null;
}

export async function mdbListPage(ctx: Ctx, listId: string, wanted: ContentType, skip: number): Promise<MetaPreview[]> {
  const k = key(ctx);
  if (!k) return [];
  const params = new URLSearchParams({
    apikey: k,
    limit: String(MDBLIST_PAGE_SIZE),
    offset: String(Math.max(0, skip)),
    append_to_response: 'genre,poster',
    unified: 'true',
  });
  if (wanted === 'movie' || wanted === 'series') params.set('mediatype', wanted === 'movie' ? 'movie' : 'show');
  const idPath = /^\d+$/.test(listId) ? listId : listId.split('/').map(encodeURIComponent).join('/');
  const data = await fetchJson<MdbItemsPayload | MdbListItem[]>(`${API}/lists/${idPath}/items?${params}`, { ttl: ITEMS_TTL, cacheScope: scoped(ctx) });
  const rows: MdbListItem[] = Array.isArray(data)
    ? data
    : wanted === 'movie' ? data?.movies ?? [] : wanted === 'series' ? data?.shows ?? [] : [...(data?.movies ?? []), ...(data?.shows ?? [])];
  return rows.map(toPreview).filter((m): m is MetaPreview => m !== null);
}

function toPreview(item: MdbListItem): MetaPreview | null {
  if (item.mediatype !== 'movie' && item.mediatype !== 'show') return null;
  const type: ContentType = item.mediatype === 'movie' ? 'movie' : 'series';
  const tmdb = item.tmdb_id ?? item.id;
  const imdb = item.imdb_id && /^tt\d+$/.test(item.imdb_id) ? item.imdb_id : undefined;
  const id = imdb ?? (tmdb ? `tmdb:${tmdb}` : item.tvdb_id ? `tvdb:${item.tvdb_id}` : undefined);
  if (!id || !item.title) return null;
  const out: MetaPreview = { id, type, name: item.title };
  if (item.poster) out.poster = item.poster;
  if (item.release_year) { out.year = item.release_year; out.releaseInfo = String(item.release_year); }
  if (Array.isArray(item.genre) && item.genre.length) out.genres = item.genre.map((g) => String(g));
  if (typeof item.score === 'number' && item.score > 0) out.imdbRating = (item.score / 10).toFixed(1);
  return out;
}

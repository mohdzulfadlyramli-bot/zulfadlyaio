import type { Ctx } from '../context';
import type { ContentType, Meta, MetaPreview, MetaVideo } from '../stremio/types';
import { fetchJson } from '../util/cache';
import type { IdBundle } from './types';

const API = 'https://v3-cinemeta.strem.io';

export const TTL_META = 12 * 3600;
export const TTL_CATALOG = 30 * 60;

interface CinemetaVideo extends Partial<MetaVideo> { id: string; name?: string; title?: string; number?: number; firstAired?: string }
interface CinemetaMeta extends Omit<Meta, 'videos'> { imdb_id?: string; moviedb_id?: number | string; tvdb_id?: number | string; videos?: CinemetaVideo[]; runtime?: string }

function cinemetaType(type: ContentType): 'movie' | 'series' {
  return type === 'movie' ? 'movie' : 'series';
}

async function rawMeta(type: ContentType, imdb: string): Promise<CinemetaMeta | null> {
  if (!/^tt\d+$/.test(imdb)) return null;
  const data = await fetchJson<{ meta?: CinemetaMeta }>(`${API}/meta/${cinemetaType(type)}/${imdb}.json`, { ttl: TTL_META });
  return data?.meta ?? null;
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function cinemetaIds(ctx: Ctx, type: ContentType, imdb: string): Promise<IdBundle> {
  const m = await rawMeta(type, imdb);
  if (!m) return { imdb };
  return { imdb, tmdb: num(m.moviedb_id), tvdb: num(m.tvdb_id), tmdbType: m.moviedb_id ? (cinemetaType(type) === 'movie' ? 'movie' : 'tv') : undefined };
}

export async function cinemetaMeta(ctx: Ctx, type: ContentType, imdb: string): Promise<Meta | null> {
  const m = await rawMeta(type, imdb);
  if (!m) return null;
  const { imdb_id, moviedb_id, tvdb_id, videos, ...rest } = m;
  const meta: Meta = {
    ...rest,
    id: m.id || imdb,
    type: cinemetaType(type),
    ids: { imdb: imdb_id || imdb, tmdb: num(moviedb_id), tvdb: num(tvdb_id) },
  };
  if (Array.isArray(videos)) {
    meta.videos = videos.map((v, i) => ({
      id: v.id,
      title: v.title || v.name || `Episode ${v.episode ?? v.number ?? i + 1}`,
      season: v.season,
      episode: v.episode ?? v.number,
      released: v.released || v.firstAired,
      thumbnail: v.thumbnail,
      overview: v.overview,
      rating: v.rating,
    }));
  }
  if (type === 'movie') meta.behaviorHints = { defaultVideoId: meta.id, hasScheduledVideos: false, ...(meta.behaviorHints ?? {}) };
  return meta;
}

export async function cinemetaCatalog(type: ContentType, catalogId: string, extra: Record<string, string | number | undefined> = {}): Promise<MetaPreview[]> {
  const parts = Object.entries(extra).filter(([, v]) => v !== undefined && v !== '' && v !== 0).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  const url = `${API}/catalog/${cinemetaType(type)}/${encodeURIComponent(catalogId)}${parts.length ? `/${parts.join('&')}` : ''}.json`;
  const data = await fetchJson<{ metas?: MetaPreview[] }>(url, { ttl: TTL_CATALOG });
  return (data?.metas ?? []).map((p) => ({ ...p, type: cinemetaType(type) }));
}

export async function cinemetaSearch(ctx: Ctx, type: ContentType, query: string, opts: { skip?: number } = {}): Promise<MetaPreview[]> {
  const q = query.trim();
  if (!q) return [];
  return cinemetaCatalog(type, 'top', { search: q, skip: opts.skip });
}

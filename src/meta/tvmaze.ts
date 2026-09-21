import type { Ctx } from '../context';
import { episodeId } from '../stremio/ids';
import type { Meta, MetaPreview, MetaVideo } from '../stremio/types';
import { fetchJson, memo } from '../util/cache';
import { buildLinks, runtimeText, toIsoNoon } from './tmdb';
import type { IdBundle } from './types';

const API = 'https://api.tvmaze.com';

export const TTL_SHOW = 24 * 3600;
export const TTL_EPISODES = 6 * 3600;
export const TTL_SEARCH = 3600;

export interface TvmazeShow {
  id: number; name: string; type?: string; language?: string; genres?: string[]; status?: string;
  runtime?: number | null; averageRuntime?: number | null; premiered?: string | null; ended?: string | null;
  rating?: { average?: number | null }; summary?: string | null;
  network?: { name?: string; country?: { code?: string; name?: string } } | null;
  webChannel?: { name?: string; country?: { code?: string; name?: string } | null } | null;
  externals?: { thetvdb?: number | null; imdb?: string | null };
  image?: { medium?: string; original?: string } | null;
  _embedded?: { cast?: Array<{ person?: { name?: string } }> };
}

export interface TvmazeEpisode {
  id: number; name?: string; season: number; number: number | null; type?: string;
  airdate?: string | null; airtime?: string | null; airstamp?: string | null; runtime?: number | null;
  image?: { medium?: string; original?: string } | null; summary?: string | null;
}

export function stripHtml(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  const text = s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  return text || undefined;
}

export async function tvmazeLookup(ctx: Ctx, ids: IdBundle): Promise<TvmazeShow | null> {
  if(ids.tvmaze)return tvmazeShow(ctx,ids.tvmaze);
  const query = ids.imdb ? `imdb=${ids.imdb}` : ids.tvdb ? `thetvdb=${ids.tvdb}` : null;
  if (!query) return null;
  const show = await memo<TvmazeShow | null>(`tvmaze:lookup:${query}`, TTL_SHOW, () => fetchJson<TvmazeShow>(`${API}/lookup/shows?${query}`, { ttl: 0, redirect: 'follow' }));
  return show ?? null;
}

export async function tvmazeShow(ctx: Ctx, id: number): Promise<TvmazeShow | null> {
  return fetchJson<TvmazeShow>(`${API}/shows/${id}?embed=cast`, { ttl: TTL_SHOW });
}

export async function tvmazeEpisodes(ctx: Ctx, id: number): Promise<TvmazeEpisode[]> {
  return (await fetchJson<TvmazeEpisode[]>(`${API}/shows/${id}/episodes?specials=1`, { ttl: TTL_EPISODES })) ?? [];
}

export async function tvmazeSearch(ctx: Ctx, query: string): Promise<MetaPreview[]> {
  const q = query.trim();
  if (!q) return [];
  const rows = await fetchJson<Array<{ show: TvmazeShow }>>(`${API}/search/shows?q=${encodeURIComponent(q)}`, { ttl: TTL_SEARCH });
  return (rows ?? []).map((r) => previewFromShow(r.show));
}

export function previewFromShow(s: TvmazeShow): MetaPreview {
  const year = s.premiered ? Number(s.premiered.slice(0, 4)) : undefined;
  return {
    id: s.externals?.imdb || (s.externals?.thetvdb ? `tvdb:${s.externals.thetvdb}` : `tvmaze:${s.id}`),
    type: 'series',
    name: s.name,
    poster: s.image?.original || s.image?.medium,
    description: stripHtml(s.summary),
    genres: s.genres,
    releaseInfo: year ? String(year) : undefined,
    year: Number.isFinite(year) ? year : undefined,
    imdbRating: s.rating?.average ? s.rating.average.toFixed(1) : undefined,
    posterShape: 'poster',
  };
}

export async function tvmazeAirDates(ctx: Ctx, ids: IdBundle): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const show = await tvmazeLookup(ctx, ids);
  if (!show) return out;
  const eps = await tvmazeEpisodes(ctx, show.id);
  let specials = 0;
  for (const e of eps) {
    const stamp = e.airstamp || (e.airdate ? toIsoNoon(e.airdate) : undefined);
    if (!stamp) continue;
    const key = e.number == null ? `0:${++specials}` : `${e.season}:${e.number}`;
    out.set(key, new Date(stamp).toISOString());
  }
  return out;
}

export function episodeToVideo(canonicalId: string, e: TvmazeEpisode, index: number): MetaVideo {
  const season = e.number == null ? 0 : e.season;
  const number = e.number == null ? index : e.number;
  const stamp = e.airstamp || (e.airdate ? toIsoNoon(e.airdate) : undefined);
  return {
    id: episodeId(canonicalId, season, number),
    title: e.name || `Episode ${number}`,
    season,
    episode: number,
    released: stamp ? new Date(stamp).toISOString() : undefined,
    overview: stripHtml(e.summary),
    thumbnail: e.image?.original || e.image?.medium,
  };
}

export async function tvmazeMeta(ctx: Ctx, ids: IdBundle, canonicalId: string, opts: { withEpisodes?: boolean } = {}): Promise<Meta | null> {
  const found = await tvmazeLookup(ctx, ids);
  if (!found) return null;
  const show = (await tvmazeShow(ctx, found.id)) ?? found;
  const base = previewFromShow(show);
  const cast = (show._embedded?.cast ?? []).map((c) => c.person?.name).filter((n): n is string => !!n).slice(0, 15);
  const startYear = base.year as number | undefined;
  const endYear = show.ended ? Number(show.ended.slice(0, 4)) : undefined;
  const ongoing = show.status === 'Running' || show.status === 'In Development';
  const imdb = show.externals?.imdb || ids.imdb;
  const meta: Meta = {
    ...base,
    id: canonicalId,
    releaseInfo: !startYear ? undefined : ongoing ? `${startYear}-` : endYear && endYear !== startYear ? `${startYear}-${endYear}` : String(startYear),
    released: show.premiered ? toIsoNoon(show.premiered) : undefined,
    runtime: runtimeText(show.runtime ?? show.averageRuntime),
    cast: cast.length ? cast : undefined,
    country: show.network?.country?.name || show.webChannel?.country?.name || undefined,
    language: show.language || undefined,
    status: show.status,
    network: show.network?.name || show.webChannel?.name || undefined,
    links: [...buildLinks({ imdb, tmdb: ids.tmdb, kind: 'tv', rating: base.imdbRating, genres: show.genres, cast }), { name: 'TVmaze', category: 'tvmaze', url: `https://www.tvmaze.com/shows/${show.id}` }],
    ids: { imdb, tvdb: show.externals?.thetvdb ?? ids.tvdb, tmdb: ids.tmdb, tvmaze:show.id },
    behaviorHints: { defaultVideoId: null, hasScheduledVideos: ongoing },
  };
  if (opts.withEpisodes !== false) {
    const eps = await tvmazeEpisodes(ctx, show.id);
    let specials = 0;
    meta.videos = eps.map((e) => episodeToVideo(canonicalId, e, e.number == null ? ++specials : 0));
  }
  return meta;
}

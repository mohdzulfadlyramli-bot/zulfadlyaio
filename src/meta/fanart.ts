import type { Ctx } from '../context';
import { fetchJson, memo } from '../util/cache';
import { fanartLanguage } from './language';
import type { IdBundle } from './types';

const API = 'https://webservice.fanart.tv/v3';
export const TTL_FANART = 7 * 24 * 3600;

export interface FanartImage { id?: string; url: string; lang?: string; likes?: string }
export interface FanartMovie {
  tmdb_id?: string; imdb_id?: string;
  movieposter?: FanartImage[]; moviebackground?: FanartImage[]; hdmovielogo?: FanartImage[]; movielogo?: FanartImage[]; moviethumb?: FanartImage[]; moviebanner?: FanartImage[];
}
export interface FanartShow {
  thetvdb_id?: string;
  tvposter?: FanartImage[]; showbackground?: FanartImage[]; hdtvlogo?: FanartImage[]; clearlogo?: FanartImage[]; tvthumb?: FanartImage[]; tvbanner?: FanartImage[];
  seasonposter?: Array<FanartImage & { season?: string }>;
}

export interface FanartArtwork { poster?: string; background?: string; logo?: string; thumb?: string }

export function hasFanart(ctx: Ctx): boolean {
  return !!ctx.cfg.keys.fanart;
}

async function fanartGet<T>(ctx: Ctx, path: string): Promise<T | null> {
  const key = ctx.cfg.keys.fanart;
  if (!key) return null;
  const hit = await memo<T | null>(`fanart:${path}`, TTL_FANART, () => fetchJson<T>(`${API}${path}?api_key=${encodeURIComponent(key)}`, { ttl: 0, timeoutMs: 10000 }));
  return hit ?? null;
}

export async function fanartMovie(ctx: Ctx, id: number | string): Promise<FanartMovie | null> {
  return id ? fanartGet<FanartMovie>(ctx, `/movies/${id}`) : null;
}

export async function fanartShow(ctx: Ctx, tvdb: number): Promise<FanartShow | null> {
  return tvdb ? fanartGet<FanartShow>(ctx, `/tv/${tvdb}`) : null;
}

export function pickFanart(list: FanartImage[] | undefined, lang: string): string | undefined {
  if (!list?.length) return undefined;
  const likes = (i: FanartImage) => Number(i.likes || 0);
  for (const pred of [(i: FanartImage) => i.lang === lang, (i: FanartImage) => i.lang === 'en', (i: FanartImage) => i.lang === '00' || !i.lang, () => true]) {
    const hit = list.filter(pred).sort((a, b) => likes(b) - likes(a))[0];
    if (hit?.url) return hit.url;
  }
  return undefined;
}

export async function fanartArtwork(ctx: Ctx, type: 'movie' | 'series', ids: IdBundle): Promise<FanartArtwork> {
  if (!hasFanart(ctx)) return {};
  const lang = fanartLanguage(ctx.cfg.language);
  if (type === 'movie') {
    const id = ids.tmdb ?? ids.imdb;
    const m = id ? await fanartMovie(ctx, id) : null;
    if (!m) return {};
    return {
      poster: pickFanart(m.movieposter, lang),
      background: pickFanart(m.moviebackground, lang),
      logo: pickFanart(m.hdmovielogo, lang) ?? pickFanart(m.movielogo, lang),
      thumb: pickFanart(m.moviethumb, lang),
    };
  }
  const s = ids.tvdb ? await fanartShow(ctx, ids.tvdb) : null;
  if (!s) return {};
  return {
    poster: pickFanart(s.tvposter, lang),
    background: pickFanart(s.showbackground, lang),
    logo: pickFanart(s.hdtvlogo, lang) ?? pickFanart(s.clearlogo, lang),
    thumb: pickFanart(s.tvthumb, lang),
  };
}

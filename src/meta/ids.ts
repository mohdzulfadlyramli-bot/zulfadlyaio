import type { Ctx } from '../context';
import { parseStremioId } from '../stremio/ids';
import type { ContentType } from '../stremio/types';
import { memo } from '../util/cache';
import { cinemetaIds } from './cinemeta';
import { tmdbFind } from './tmdb';
import { hasTvdb, idsFromRecord, tvdbByRemoteId, tvdbRecord } from './tvdb';
import type { IdBundle } from './types';
import { tvmazeShow } from './tvmaze';

export const TTL_IDS = 7 * 24 * 3600;

export function bundleFromStremioId(id: string): IdBundle {
  const p = parseStremioId(id);
  switch (p.source) {
    case 'imdb': return { imdb: p.key };
    case 'tmdb': return { tmdb: p.num };
    case 'tvdb': return { tvdb: p.num };
    case 'tvmaze': return {tvmaze:p.num};
    case 'mal': return { mal: p.num };
    case 'anilist': return { anilist: p.num };
    case 'kitsu': return { kitsu: p.num };
    case 'anidb': return { anidb: p.num };
    default: return {};
  }
}

export function isAnimeId(id: string): boolean {
  const s = parseStremioId(id).source;
  return s === 'mal' || s === 'anilist' || s === 'kitsu' || s === 'anidb';
}

function tmdbKindFor(type: ContentType, ids: IdBundle): 'movie' | 'tv' | undefined {
  if (ids.tmdbType) return ids.tmdbType;
  if (type === 'movie') return 'movie';
  if (type === 'series' || type === 'anime' || type === 'tv') return 'tv';
  return undefined;
}

function complete(ids: IdBundle): boolean {
  return !!(ids.imdb && ids.tmdb && ids.tvdb);
}

function merge(into: IdBundle, from: IdBundle | null | undefined): IdBundle {
  if (!from) return into;
  const out = { ...into };
  for (const k of ['imdb', 'tmdb', 'tvdb', 'tvmaze', 'mal', 'anilist', 'kitsu', 'anidb', 'tmdbType'] as const) {
    if (out[k] === undefined && from[k] !== undefined) (out as Record<string, unknown>)[k] = from[k];
  }
  return out;
}

async function bridgeUncached(ctx: Ctx, seed: IdBundle, type: ContentType): Promise<IdBundle> {
  let ids: IdBundle = { ...seed, tmdbType: tmdbKindFor(type, seed) };
  const tvdbKind = type === 'movie' ? 'movie' : 'series';
  if(ids.tvmaze){const show=await tvmazeShow(ctx,ids.tvmaze);ids=merge(ids,{imdb:show?.externals?.imdb??undefined,tvdb:show?.externals?.thetvdb??undefined});}

  if (ctx.tmdbKey && !complete(ids)) ids = merge(ids, await tmdbFind(ctx, ids));

  if (hasTvdb(ctx) && !complete(ids)) {
    if (ids.tvdb && (!ids.imdb || !ids.tmdb)) {
      const rec = await tvdbRecord(ctx, tvdbKind, ids.tvdb);
      if (rec) ids = merge(ids, idsFromRecord(rec));
    } else if (!ids.tvdb) {
      const found = (ids.imdb && (await tvdbByRemoteId(ctx, ids.imdb, tvdbKind))) || (ids.tmdb && (await tvdbByRemoteId(ctx, String(ids.tmdb), tvdbKind)));
      if (found) ids.tvdb = found;
    }
    if (ctx.tmdbKey && ids.tvdb && !ids.tmdb) ids = merge(ids, await tmdbFind(ctx, ids));
  }

  if (ids.imdb && (!ids.tmdb || !ids.tvdb) && type !== 'anime' && (type === 'movie' ? ctx.cfg.providers.movie : ctx.cfg.providers.series) === 'cinemeta') ids = merge(ids, await cinemetaIds(ctx, type, ids.imdb));

  if (!ids.tmdb) delete ids.tmdbType;
  return ids;
}

export async function bridgeIds(ctx: Ctx, seed: IdBundle, type: ContentType): Promise<IdBundle> {
  const anchor = seed.imdb ? `imdb:${seed.imdb}` : seed.tmdb ? `tmdb:${seed.tmdb}` : seed.tvdb ? `tvdb:${seed.tvdb}` : seed.tvmaze?`tvmaze:${seed.tvmaze}`:null;
  if (!anchor) return { ...seed };
  const kind = type === 'movie' ? 'movie' : 'series';
  const reach = `${ctx.tmdbKey ? 't' : ''}${hasTvdb(ctx) ? 'v' : ''}${(type === 'movie' ? ctx.cfg.providers.movie : ctx.cfg.providers.series) === 'cinemeta' ? 'c' : ''}`;
  const hit = await memo<IdBundle>(`ids:v2:${kind}:${reach}:${anchor}`, TTL_IDS, () => bridgeUncached(ctx, seed, type));
  return merge(seed, hit);
}

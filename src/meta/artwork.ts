import type { Ctx } from '../context';
import type { ContentType } from '../stremio/types';
import { fanartArtwork, hasFanart, type FanartArtwork } from './fanart';
import { hasTvdb, tvdbArtwork, type TvdbArtwork } from './tvdb';
import { tmdbImages, type TmdbArtwork } from './tmdb';
import type { IdBundle } from './types';

export interface ArtworkSet { poster?: string; background?: string; logo?: string }
export type ArtSource = 'tmdb' | 'fanart' | 'tvdb' | 'rpdb' | 'metahub';

export interface ProvidedArtwork { tmdb?: TmdbArtwork; tvdb?: TvdbArtwork; fanart?: FanartArtwork }

export function metahubUrl(kind: 'poster' | 'background' | 'logo', imdb: string | undefined): string | undefined {
  return imdb ? `https://images.metahub.space/${kind}/medium/${imdb}/img` : undefined;
}

export function rpdbPoster(key: string | undefined, ids: IdBundle, type: ContentType): string | undefined {
  if (!key) return undefined;
  if (ids.imdb) return `https://api.ratingposterdb.com/${key}/imdb/poster-default/${ids.imdb}.jpg`;
  if (ids.tmdb) return `https://api.ratingposterdb.com/${key}/tmdb/poster-default/${type === 'movie' ? 'movie' : 'series'}-${ids.tmdb}.jpg`;
  return undefined;
}

type Slot = keyof ArtworkSet;

export async function mergeArtwork(ctx: Ctx, type: ContentType, ids: IdBundle, provided: ProvidedArtwork = {}): Promise<ArtworkSet> {
  const kind = type === 'movie' ? 'movie' : 'series';
  const { posters, backgrounds, logos } = ctx.cfg.artwork;

  let tmdbP: Promise<TmdbArtwork> | undefined;
  let tvdbP: Promise<TvdbArtwork> | undefined;
  let fanartP: Promise<FanartArtwork> | undefined;
  const fromTmdb = () => provided.tmdb ? Promise.resolve(provided.tmdb) : (tmdbP ??= ctx.tmdbKey && ids.tmdb ? tmdbImages(ctx, kind === 'movie' ? 'movie' : 'tv', ids.tmdb) : Promise.resolve<TmdbArtwork>({}));
  const fromTvdb = () => provided.tvdb ? Promise.resolve(provided.tvdb) : (tvdbP ??= hasTvdb(ctx) && ids.tvdb ? tvdbArtwork(ctx, kind, ids.tvdb) : Promise.resolve<TvdbArtwork>({}));
  const fromFanart = () => provided.fanart ? Promise.resolve(provided.fanart) : (fanartP ??= hasFanart(ctx) ? fanartArtwork(ctx, kind, ids) : Promise.resolve<FanartArtwork>({}));

  const resolve = async (slot: Slot, source: ArtSource): Promise<string | undefined> => {
    switch (source) {
      case 'tmdb': return (await fromTmdb())[slot];
      case 'tvdb': return (await fromTvdb())[slot];
      case 'fanart': return (await fromFanart())[slot];
      case 'rpdb': return slot === 'poster' ? rpdbPoster(ctx.cfg.keys.rpdb, ids, type) : undefined;
      case 'metahub': return metahubUrl(slot, ids.imdb);
      default: return undefined;
    }
  };

  const pick = async (slot: Slot, order: ArtSource[]): Promise<string | undefined> => {
    for (const source of order) {
      const hit = await resolve(slot, source);
      if (hit) return hit;
    }
    return undefined;
  };

  const [poster, background, logo] = await Promise.all([
    pick('poster', posters),
    pick('background', backgrounds),
    pick('logo', logos),
  ]);
  return { poster, background, logo };
}

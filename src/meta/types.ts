import type { Ctx } from '../context';
import type { ContentType, Meta, MetaPreview } from '../stremio/types';

export interface MetaSource {
  name: string;
  meta(ctx: Ctx, type: ContentType, id: string): Promise<Meta | null>;
  search?(ctx: Ctx, type: ContentType, query: string, opts?: { skip?: number; limit?: number }): Promise<MetaPreview[]>;
}

export interface IdBundle {
  imdb?: string;
  tmdb?: number;
  tvdb?: number;
  tvmaze?: number;
  mal?: number;
  anilist?: number;
  kitsu?: number;
  anidb?: number;
  tmdbType?: 'movie' | 'tv';
}

export interface MetaApi {
  resolveMeta(ctx: Ctx, type: ContentType, id: string): Promise<Meta | null>;
  searchMeta(ctx: Ctx, type: ContentType, query: string, opts?: { skip?: number; limit?: number }): Promise<MetaPreview[]>;
  resolveIds(ctx: Ctx, id: string, type?: ContentType): Promise<IdBundle>;
  canonicalId(ids: IdBundle, type: ContentType): string | null;
}

export interface AnimeApi {
  animeMeta(ctx: Ctx, id: string): Promise<Meta | null>;
  animeSearch(ctx: Ctx, query: string, opts?: { skip?: number; limit?: number }): Promise<MetaPreview[]>;
  mapAnimeIds(ctx: Ctx, ids: IdBundle): Promise<IdBundle>;
  isAnime(ids: IdBundle, genres?: string[]): Promise<boolean>;
}

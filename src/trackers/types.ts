import type { Ctx } from '../context';
import type { IdBundle } from '../meta/types';
import type { TrackerName } from '../config/schema';
import type { ManifestCatalog, MetaPreview } from '../stremio/types';

export interface ResumeEntry {
  positionMs?: number;
  runtimeMs?: number;
  ids: IdBundle;
  kind: 'movie' | 'episode';
  season?: number;
  episode?: number;
  progress: number;
  at: string;
  ref?: string | number;
}

export interface WatchedMovie { ids: IdBundle; plays: number; lastAt: string }
export interface WatchedEpisode { ids: IdBundle; season: number; episode: number; plays: number; lastAt: string }

export interface WatchSnapshot {
  dropped?: IdBundle[];
  local?: Array<{ids:IdBundle;kind:'movie'|'episode';season?:number;episode?:number;watched:boolean;progress:number;positionMs?:number;runtimeMs?:number;at:string}>;
  movies: WatchedMovie[];
  episodes: WatchedEpisode[];
  shows: Array<{ ids: IdBundle; lastAt: string; lastSeason?: number; lastEpisode?: number }>;
  resume: ResumeEntry[];
  fetchedAt: string;
}

export type ScrobbleAction = 'start' | 'pause' | 'stop';

export interface ScrobbleEvent {
  at?: string;
  positionMs?: number;
  numbering?: 'anime' | 'tvdb' | 'tmdb';
  animeEpisode?: { mal?: number; anilist?: number; kitsu?: number; anidb?: number; episode: number };
  deliveryId?: string;
  action: ScrobbleAction;
  ids: IdBundle;
  kind: 'movie' | 'episode';
  season?: number;
  episode?: number;
  progress: number;
  runtimeMs?: number;
}

export interface MarkEvent {
  deliveryId?: string;
  at?: string;
  numbering?: ScrobbleEvent['numbering'];
  animeEpisode?: ScrobbleEvent['animeEpisode'];
  ids: IdBundle;
  kind: 'movie' | 'episode' | 'series';
  season?: number;
  episode?: number;
  watched: boolean;
}

export interface DropEvent {
  ids: IdBundle;
  dropped: boolean;
  at: number;
  scope: string;
  source?: TrackerName;
  itemId?: string;
  rating?: { itemId: string; likes: boolean | null; profile: string };
}

export interface Tracker {
  name: TrackerName;
  ready(ctx: Ctx): boolean;
  snapshot(ctx: Ctx): Promise<WatchSnapshot>;
  scrobble(ctx: Ctx, ev: ScrobbleEvent): Promise<void>;
  mark(ctx: Ctx, ev: MarkEvent): Promise<void>;
  clearResume?(ctx: Ctx, entry: ResumeEntry): Promise<void>;
  drop?(ctx: Ctx, event: DropEvent): Promise<void>;
  catalogs?(ctx: Ctx): Promise<ManifestCatalog[]>;
  catalogItems?(ctx: Ctx, catalogId: string, skip: number): Promise<MetaPreview[]>;
}

export interface TrackerApi {
  primary(ctx: Ctx): Tracker | null;
  sinks(ctx: Ctx): Tracker[];
  snapshot(ctx: Ctx): Promise<WatchSnapshot>;
  scrobble(ctx: Ctx, ev: ScrobbleEvent): Promise<void>;
  mark(ctx: Ctx, ev: MarkEvent): Promise<void>;
  clearResume(ctx: Ctx, entry: ResumeEntry): Promise<void>;
  drop(ctx: Ctx, ids: IdBundle, dropped: boolean, itemId?: string, rating?: DropEvent['rating']): Promise<void>;
  invalidate(ctx: Ctx): Promise<void>;
}

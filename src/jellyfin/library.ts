import { catalogPage, enabledCatalogDefinitions, type CatalogDefinition } from '../addon/catalogs';
import { metaAddons } from '../config/schema';
import { aiQuery,aiSearch } from '../addon/ai';
import { trackerTargets } from '../trackers/targets';
import { externalMeta } from '../stremio/client';
import { metaApi } from '../meta/index';
import { tmdbList, tmdbMeta } from '../meta/tmdb';
import { applyAgeCap } from '../addon/agecap';
import { passesAgeCap } from '../meta/rating';
import type { IdBundle } from '../meta/types';
import { episodeId as stremioEpisodeId, type IdSource } from '../stremio/ids';
import type { ContentType, Meta, MetaPreview, MetaVideo } from '../stremio/types';
import { trackerApi } from '../trackers/index';
import type { ResumeEntry, WatchSnapshot, WatchedEpisode, WatchedMovie } from '../trackers/types';
import { mapLimit, uniq } from '../util/concurrency';
import { cacheGet, cachePut } from '../util/cache';
import { sha256 } from '../util/bytes';
import { collectionFolder, episodeItem, placeholderSource, runtimeTicks, seasonItem, titleItem, userData, type Dto } from './dto';
import {
  decodeGuid,
  encodeGuid,
  episodeIdOf,
  fnv1a32,
  isAnimeSource,
  parentSeriesOf,
  plainGuid,
  seasonIdOf,
  stremioIdOfGuid,
  titleRoot,
  viewHash,
  viewIdOf,
  type LabelGuid,
  type TitleGuid,
} from './ids';
import type { JfRequest } from './request';
import { rememberPeople } from './people';
import { enrichWithTmdb } from './enrichment';
import { favoriteIds, saveFavorite } from '../storage/favorites';
import { itemRatings, saveRating } from '../storage/ratings';
import { overlayDropped, showKeys } from '../storage/dropped';

export const SHELF_LIMIT = 20;
export const SHELF_CONCURRENCY = 4;
const MAX_WINDOW_PAGES = 64;
const WINDOW_HEADROOM = 6;
const UPCOMING_DAYS = 90;

interface CatalogShape {
  id: string;
  type: ContentType;
  name: string;
  group?: string;
  genres?: string[];
  extra?: Array<{ name: string; isRequired?: boolean; options?: string[] }>;
  enabled?: boolean;
}

export interface CatalogRef {
  id: string;
  type: ContentType;
  name: string;
  group: string;
  genres: string[];
  searchable: boolean;
  browsable: boolean;
  viewId: string;
  hash: number;
}

export function collectionTypeOf(type: ContentType): 'movies' | 'tvshows' | null {
  if (type === 'movie') return 'movies';
  if (type === 'series' || type === 'anime') return 'tvshows';
  return null;
}

export type ItemType = 'Movie' | 'Series' | 'Episode' | 'Season' | 'BoxSet';

function kindOfPreview(m: MetaPreview, catType: ContentType): 'movie' | 'series' {
  const t = m.type || catType;
  return t === 'movie' ? 'movie' : 'series';
}

function key(source: IdSource, num: number): string {
  return `${source}:${num}`;
}

export function bundleKeys(ids: IdBundle | Meta['ids'] | undefined): string[] {
  const out: string[] = [];
  if (!ids) return out;
  if (ids.imdb) {
    const n = Number(String(ids.imdb).replace(/^tt/i, ''));
    if (Number.isFinite(n)) out.push(key('imdb', n));
  }
  for (const s of ['tmdb', 'tvdb', 'tvmaze', 'mal', 'anilist', 'kitsu', 'anidb'] as const) {
    const v = ids[s];
    if (typeof v === 'number' && Number.isFinite(v)) out.push(key(s, v));
  }
  return out;
}

export function bundleOf(g: TitleGuid, meta?: Meta | null): IdBundle {
  const b: IdBundle = { ...(meta?.ids ?? {}) };
  if (g.source === 'imdb') b.imdb ??= `tt${String(g.num).padStart(7, '0')}`;
  else if (g.source !== 'other'&&g.source!=='tvdbc'&&g.source!=='tmdbc') b[g.source] ??= g.num;
  if (g.kind === 'movie') b.tmdbType ??= 'movie';
  else b.tmdbType ??= 'tv';
  return b;
}

interface EpisodeMark {
  plays: number;
  lastAt: string;
}

export class WatchIndex {
  readonly dropped: Set<string>;
  readonly localEpisodes=new Map<string,NonNullable<WatchSnapshot['local']>[number]>();
  readonly movies = new Map<string, WatchedMovie>();
  private episodeIndex?: Map<string, Map<string, EpisodeMark>>;
  readonly resumeMovies = new Map<string, ResumeEntry>();
  readonly resumeEpisodes = new Map<string, Map<string, ResumeEntry>>();
  private showIndex?: Map<string, WatchSnapshot['shows'][number]>;

  constructor(readonly snapshot: WatchSnapshot) {
    this.dropped = new Set((snapshot.dropped ?? []).flatMap(showKeys));
    for(const r of snapshot.local ?? []) if(r.kind==='episode') for(const k of bundleKeys(r.ids)) this.localEpisodes.set(`${k}:${r.season ?? 1}:${r.episode}`,r);
    for (const m of snapshot.movies ?? []) for (const k of bundleKeys(m.ids)) this.movies.set(k, m);
    for (const r of snapshot.resume ?? []) {
      for (const k of bundleKeys(r.ids)) {
        if (r.kind === 'movie') {
          this.resumeMovies.set(k, r);
          continue;
        }
        let map = this.resumeEpisodes.get(k);
        if (!map) this.resumeEpisodes.set(k, (map = new Map()));
        for (const ek of episodeKeys(r.season, r.episode)) map.set(ek, r);
      }
    }
  }

  get episodes(): Map<string, Map<string, EpisodeMark>> {
    if (!this.episodeIndex) {
      const index = this.episodeIndex = new Map();
      for (const e of this.snapshot.episodes ?? []) {
        for (const k of bundleKeys(e.ids)) {
          let map = index.get(k);
          if (!map) index.set(k, (map = new Map()));
          for (const ek of episodeKeys(e.season, e.episode)) map.set(ek, { plays: e.plays, lastAt: e.lastAt });
        }
      }
    }
    return this.episodeIndex;
  }

  get shows(): Map<string, WatchSnapshot['shows'][number]> {
    if (!this.showIndex) {
      this.showIndex = new Map();
      for (const s of this.snapshot.shows ?? []) for (const k of bundleKeys(s.ids)) this.showIndex.set(k, s);
    }
    return this.showIndex;
  }

  movie(keys: string[]): { watched?: WatchedMovie; resume?: ResumeEntry } {
    const out: { watched?: WatchedMovie; resume?: ResumeEntry } = {};
    for (const k of keys) {
      out.watched ??= this.movies.get(k);
      out.resume ??= this.resumeMovies.get(k);
    }
    return out;
  }

  isDropped(keys: string[]): boolean { return keys.some(key => this.dropped.has(key)); }

  episode(keys: string[], season: number, episode: number): { watched?: EpisodeMark; resume?: ResumeEntry } {
    const out: { watched?: EpisodeMark; resume?: ResumeEntry } = {};
    for (const k of keys) {
      const w = this.episodes.get(k);
      const r = this.resumeEpisodes.get(k);
      for (const ek of episodeKeys(season, episode)) {
        out.watched ??= w?.get(ek);
        out.resume ??= r?.get(ek);
      }
    }
    return out;
  }

  localEpisode(keys:string[],season:number,episode:number): {watched?:EpisodeMark;resume?:ResumeEntry}|null {
    for(const k of keys) {
      const row=this.localEpisodes.get(`${k}:${season}:${episode}`);
      if(row) return {watched:row.watched ? {plays:1,lastAt:row.at}:undefined,resume:row.progress>0 || (row.positionMs ?? 0)>0 ? {...row,kind:'episode'}:undefined};
    }
    return null;
  }

  show(keys: string[]): WatchSnapshot['shows'][number] | undefined {
    for (const k of keys) {
      const s = this.shows.get(k);
      if (s) return s;
    }
    return undefined;
  }

  knowsShow(keys: string[]): boolean {
    return keys.some((k) => this.episodes.has(k) || this.resumeEpisodes.has(k) || this.shows.has(k));
  }
}

function episodeKeys(season: number | undefined, episode: number | undefined): string[] {
  const e = episode ?? 0;
  const keys = [`${season ?? 1}:${e}`];
  if (season === undefined || season === 1) keys.push(`abs:${e}`);
  return keys;
}

export interface EpisodeView {
  season: number;
  episode: number;
  video: MetaVideo;
  id: string;
  seasonId: string;
}

export interface SeasonView {
  number: number;
  id: string;
  episodes: EpisodeView[];
}

export interface Show {
  guid: TitleGuid;
  id: string;
  meta: Meta;
  seasons: SeasonView[];
  episodes: EpisodeView[];
  keys: string[];
}

export function episodesOf(meta: Meta, series: TitleGuid): { seasons: SeasonView[]; episodes: EpisodeView[] } {
  const videos = Array.isArray(meta.videos) ? meta.videos : [];
  const seen = new Set<string>();
  const perSeasonCounter = new Map<number, number>();
  const episodes: EpisodeView[] = [];
  for (const v of videos) {
    if (!v || typeof v !== 'object') continue;
    const season = Number.isInteger(v.season) ? Number(v.season) : 1;
    const next = (perSeasonCounter.get(season) ?? 0) + 1;
    perSeasonCounter.set(season, next);
    const episode = Number.isInteger(v.episode) ? Number(v.episode) : next;
    const k = `${season}:${episode}`;
    if (seen.has(k)) continue;
    seen.add(k);
    let id: string | undefined, seasonId: string | undefined;
    episodes.push({ season, episode, video: v,
      get id() { return id ??= episodeIdOf(series, season, episode); },
      get seasonId() { return seasonId ??= seasonIdOf(series, season); },
    });
  }
  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
  const bySeason = new Map<number, EpisodeView[]>();
  for (const e of episodes) {
    let list = bySeason.get(e.season);
    if (!list) bySeason.set(e.season, (list = []));
    list.push(e);
  }
  const seasons = [...bySeason.entries()].sort((a, b) => a[0] - b[0]).map(([number, eps]) => ({ number, id: seasonIdOf(series, number), episodes: eps }));
  return { seasons, episodes };
}

export function guidOfPreview(m: MetaPreview, catType: ContentType): TitleGuid | null {
  const root = titleRoot(String(m.id ?? ''));
  if (!root) return null;
  const kind = kindOfPreview(m, catType);
  return { kind, source: root.source, num: root.num, anime: catType === 'anime' || m.type === 'anime' || isAnimeSource(root.source) };
}

function metaTypeFor(g: TitleGuid): ContentType {
  if (g.anime) return 'anime';
  return g.kind === 'movie' ? 'movie' : 'series';
}

function isReleased(v: MetaVideo): boolean {
  if (!v.released) return true;
  const t = Date.parse(v.released);
  return !Number.isFinite(t) || t <= Date.now();
}

export class Library {
  private episodeBook=new Map<string,{show:Show;episode:EpisodeView}>();
  private episodeStates=new Map<string,Promise<{watched?:EpisodeMark;resume?:ResumeEntry}>>();
  private catalogsPromise?: Promise<CatalogRef[]>;
  private watchPromise?: Promise<WatchIndex>;
  private favoritesPromise?: Promise<Set<string>>;
  private ratingsPromise?: Promise<Map<string, boolean>>;
  private readonly metas = new Map<string, Promise<Meta | null>>();
  private readonly keyBook = new Map<string, string[]>();

  constructor(readonly jf: JfRequest) {}

  get ctx() {
    return this.jf.ctx;
  }

  favorites(): Promise<Set<string>> {
    this.favoritesPromise ??= favoriteIds(this.ctx);
    return this.favoritesPromise;
  }

  async setFavorite(id: string, favorite: boolean): Promise<void> {
    await saveFavorite(this.ctx, id, favorite);
    this.favoritesPromise = undefined;
  }

  ratings(): Promise<Map<string, boolean>> {
    this.ratingsPromise ??= (async () => {
      const [ratings, idx] = await Promise.all([itemRatings(this.ctx), this.watch()]);
      for (const [id, likes] of ratings) {
        const g = decodeGuid(id);
        if (!g || g.kind === 'movie' || g.kind === 'misc' || g.kind === 'view') continue;
        if (idx.isDropped(this.keysOf(id, g))) ratings.set(id, false);
        else if (!likes) ratings.delete(id);
      }
      for (const ids of idx.snapshot.dropped ?? []) {
        const g = this.guidOfBundle(ids, 'series');
        if (g) ratings.set(encodeGuid(g), false);
      }
      return ratings;
    })();
    return this.ratingsPromise;
  }

  async setRating(id: string, likes: boolean | null): Promise<void> {
    const g = decodeGuid(id);
    if (g && (g.kind === 'series' || g.kind === 'season' || g.kind === 'episode')) {
      const root = parentSeriesOf(g);
      const ids = bundleOf(root, await this.meta(root));
      const previous = this.watchPromise;
      await trackerApi.drop(this.ctx, ids, likes === false, encodeGuid(root), { itemId: id, likes: likes === false ? null : likes, profile: this.ctx.profile?.id ?? '' });
      this.watchPromise = previous?.then(async idx => new WatchIndex(await overlayDropped(this.ctx, idx.snapshot)));
    } else await saveRating(this.ctx, id, likes);
    this.ratingsPromise = undefined;
  }

  async decorateUserData(records: Dto[]): Promise<void> {
    if (!records.length) return;
    const [favorites, ratings] = await Promise.all([this.favorites(), this.ratings()]);
    for (const record of records) {
      const id = plainGuid(record.ItemId ?? record.Key);
      record.IsFavorite = favorites.has(id);
      record.Likes = ratings.get(id) ?? null;
      const g = decodeGuid(id);
      if (g && (g.kind === 'series' || g.kind === 'season' || g.kind === 'episode') && (await this.watch()).isDropped(this.keysOf(id, g))) record.Likes = false;
    }
  }

  async decoratePreferences(items: Dto[]): Promise<Dto[]> {
    if (!items.length) return items;
    for (const item of items) {
      const id = String(item.Id ?? '');
      item.UserData = { ...userData(id), ...(item.UserData as Dto | undefined) };
    }
    await this.decorateUserData(items.map(item => item.UserData as Dto));
    return items;
  }

  catalogs(): Promise<CatalogRef[]> {
    this.catalogsPromise ??= (async () => {
      let defs: CatalogDefinition[] = [];
      try {
        defs = (await enabledCatalogDefinitions(this.ctx)) ?? [];
      } catch {
        defs = [];
      }
      const toggles = this.ctx.cfg.catalogs;
      const order = new Map(toggles.map((t, i) => [`${t.type}:${t.id}`, i]));
      const refs: CatalogRef[] = [];
      for (const raw of defs) {
        const d = raw as unknown as CatalogShape;
        if (!d?.id || !d.type) continue;
        if (this.ctx.profile?.catalogs?.length && !this.ctx.profile.catalogs.includes(d.id)) continue;
        const toggle = toggles.find((t) => t.id === d.id && t.type===d.type);
        const enabled = typeof d.enabled === 'boolean' ? d.enabled : toggle ? toggle.enabled : true;
        if (!enabled) continue;
        const extra = Array.isArray(d.extra) ? d.extra : [];
        const genreExtra = extra.find((e) => e?.name === 'genre');
        refs.push({
          id: d.id,
          type: d.type,
          name: toggle?.name || d.name || d.id,
          group: d.group ?? '',
          genres: (Array.isArray(d.genres) ? d.genres : genreExtra?.options ?? []).filter((g) => typeof g === 'string' && g && g !== 'None'),
          searchable: extra.some((e) => e?.name === 'search'),
          browsable: !extra.some((e) => e?.isRequired),
          viewId: viewIdOf(d.type, d.id),
          hash: viewHash(d.type, d.id),
        });
      }
      refs.sort((a, b) => (order.get(`${a.type}:${a.id}`) ?? 1e9) - (order.get(`${b.type}:${b.id}`) ?? 1e9));
      return refs;
    })();
    return this.catalogsPromise;
  }

  async browsable(): Promise<CatalogRef[]> {
    return (await this.catalogs()).filter((c) => c.browsable);
  }

  async views(): Promise<Dto[]> {
    const { visibleCollections, collectionViewDto } = await import('./collections');
    const collections = (await visibleCollections(this)).map((c) => collectionViewDto(this, c));
    return [...collections, ...(await this.browsable()).map((c) => collectionFolder(c.viewId, this.jf.who, c.name, collectionTypeOf(c.type)))];
  }

  async viewOf(g: LabelGuid | null | undefined): Promise<CatalogRef | null> {
    if (!g || g.kind !== 'view') return null;
    return (await this.catalogs()).find((c) => c.hash === g.hash) ?? null;
  }

  async genreNameOf(g: LabelGuid): Promise<string> {
    const all = new Set<string>();
    for (const c of await this.catalogs()) for (const name of c.genres) all.add(name);
    for (const name of all) if (fnv1a32(name) === g.hash) return name;
    return g.hint;
  }

  async window(cat: CatalogRef, start: number, limit: number, extra: { search?: string; genre?: string } = {}): Promise<{ items: MetaPreview[]; hasMore: boolean }> {
    const collected: MetaPreview[] = [];
    const seen = new Set<string>();
    let skip = Math.max(0, start);
    let pages = 0;
    let exhausted = false;
    let pageSize = 0;
    while (collected.length < limit && pages < Math.min(MAX_WINDOW_PAGES, Math.ceil(limit / Math.max(1, pageSize)) + WINDOW_HEADROOM)) {
      let page: MetaPreview[] = [];
      let consumed = 0;
      try {
        const result = await catalogPage(this.ctx, cat.type, cat.id, { ...extra, skip: skip || undefined });
        page = result.items;
        consumed = result.consumed;
      } catch {
        page = [];
      }
      pages++;
      if (!consumed) {
        exhausted = true;
        break;
      }
      pageSize = Math.max(pageSize, consumed);
      for (const m of page) {
        const id = String(m?.id ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if (this.allowed((m as Meta).certification)) collected.push(m);
      }
      skip += consumed;
      if (consumed < pageSize) {
        exhausted = true;
        break;
      }
    }
    return { items: collected.slice(0, limit), hasMore: !exhausted };
  }

  allowed(cert: string | undefined | null): boolean {
    const cap = this.ctx.cfg.ageCap;
    if (!cap) return true;
    try {
      return passesAgeCap(cert ?? undefined, cap);
    } catch {
      return true;
    }
  }

  previewItem(m: MetaPreview, cat: CatalogRef, parentId: string | null): Dto | null {
    const g = guidOfPreview(m, cat.type);
    if (!g) return null;
    const id = encodeGuid(g);
    this.noteKeys(id, g, (m as Meta).ids);
    const item = titleItem(m, g, id, this.jf.who, { parentId });
    if (g.kind === 'movie'&&item.Type!=='BoxSet') item.MediaSources = [placeholderSource(id)];
    return item;
  }

  titleItemOf(meta: Meta, g: TitleGuid, parentId: string | null = null): Dto {
    const id = encodeGuid(g);
    this.noteKeys(id, g, meta.ids);
    const opts: { parentId: string | null; seasonCount?: number; episodeCount?: number } = { parentId };
    if (g.kind === 'series') {
      const { seasons, episodes } = episodesOf(meta, g);
      opts.seasonCount = seasons.length;
      opts.episodeCount = episodes.length;
    }
    const item = titleItem(meta, g, id, this.jf.who, opts);
    if (g.kind === 'movie'&&item.Type!=='BoxSet') item.MediaSources = [placeholderSource(id)];
    return item;
  }

  private noteKeys(id: string, g: TitleGuid, ids?: Meta['ids']): void {
    const keys = uniq([key(g.source, g.num), ...bundleKeys(ids)], (k) => k);
    this.keyBook.set(id, keys);
  }

  keysOf(id: string, g?: TitleGuid | null): string[] {
    const known = this.keyBook.get(id);
    if (known) return known;
    return g ? [key(g.source, g.num)] : [];
  }

  meta(g: TitleGuid): Promise<Meta | null> {
    const title = g.kind === 'movie' ? g : parentSeriesOf(g);
    const stremioId = stremioIdOfGuid(title);
    const k = `${metaTypeFor(title)}:${stremioId}`;
    let p = this.metas.get(k);
    if (!p) {
      p = (async () => {
        const type = metaTypeFor(title);
        const cacheKey = `jf-meta:v1:${this.ctx.scope}:${this.ctx.cacheRevision ?? this.ctx.cfgToken}:${this.ctx.cfg.ageCap}:${k}`;
        const cached = await cacheGet<{meta: Meta | null}>(cacheKey, this.ctx.origin);
        if (cached) return cached.meta;
        let meta: Meta | null = null;
        try {
          meta = await metaApi.resolveMeta(this.ctx, type, stremioId);
          if (!meta && type === 'anime') meta = await metaApi.resolveMeta(this.ctx, title.kind === 'movie' ? 'movie' : 'series', stremioId);
        } catch {
          meta = null;
        }
        if (!meta && metaAddons(this.ctx.cfg).length) {
          meta = await externalMeta(this.ctx, type, stremioId).catch(() => null);
          if (!meta && type === 'anime') meta = await externalMeta(this.ctx, title.kind === 'movie' ? 'movie' : 'series', stremioId).catch(() => null);
        }
        // Related titles and filmographies use TMDB IDs, even in add-on-only mode.
        if (!meta && this.ctx.tmdbKey && title.source === 'tmdb') {
          meta = await tmdbMeta(this.ctx, title.kind === 'movie' ? 'movie' : 'tv', title.num, stremioId).catch(() => null);
        }
        if (meta) meta = await enrichWithTmdb(this.ctx, meta, bundleOf(title, meta), title.anime);
        if (meta && !this.allowed(meta.certification)) meta = null;
        if(meta)await rememberPeople(this.ctx,meta).catch(() => {});
        // Reuse the resolved metadata, including enrichment and episode lists.
        await cachePut(cacheKey, {meta}, meta ? 300 : 30, this.ctx.origin);
        return meta;
      })();
      this.metas.set(k, p);
    }
    return p;
  }

  async show(g: TitleGuid): Promise<Show | null> {
    const series = parentSeriesOf(g);
    const meta = await this.meta(series);
    if (!meta) return null;
    const id = encodeGuid(series);
    this.noteKeys(id, series, meta.ids);
    const { seasons, episodes } = episodesOf(meta, series);
    return { guid: series, id, meta, seasons, episodes, keys: this.keysOf(id, series) };
  }

  findEpisode(show: Show, g: TitleGuid): EpisodeView | undefined {
    if (g.kind !== 'episode' || g.episode === undefined) return undefined;
    const s = g.season ?? 1;
    return show.episodes.find((e) => e.season === s && e.episode === g.episode) ?? (s === 1 ? show.episodes.find((e) => e.episode === g.episode && show.seasons.length === 1) : undefined);
  }

  streamIdOf(show: Show | null, g: TitleGuid): string {
    return this.streamIdsOf(show, g)[0];
  }

  streamIdsOf(show: Show | null, g: TitleGuid, meta?: Meta | null): string[] {
    const ids = meta?.ids ?? show?.meta.ids;
    const imdb = ids?.imdb && /^tt\d+$/.test(ids.imdb) ? ids.imdb : g.source === 'imdb' ? stremioIdOfGuid(g) : null;
    const canonical = stremioIdOfGuid(g);
    if (g.kind === 'movie' || g.kind === 'series') {
      return uniq([canonical, imdb, ids?.kitsu ? `kitsu:${ids.kitsu}` : null, ids?.tmdb ? `tmdb:${ids.tmdb}` : null, ids?.mal ? `mal:${ids.mal}` : null].filter((x): x is string => !!x), (x) => x);
    }
    const ep = show ? this.findEpisode(show, g) : undefined;
    const video = ep?.video?.id ? String(ep.video.id) : null;
    const season = g.season ?? 1;
    const episode = g.episode ?? 1;
    const absolute = ep?.video?.episode ?? episode;
    return uniq([video, imdb ? `${imdb}:${season}:${episode}` : null, ids?.kitsu ? `kitsu:${ids.kitsu}:${absolute}` : null, ids?.tmdb ? `tmdb:${ids.tmdb}:${season}:${episode}` : null, ids?.mal ? `mal:${ids.mal}:${absolute}` : null, stremioEpisodeId(canonical, season, episode)].filter((x): x is string => !!x), (x) => x);
  }

  streamTypeOf(g: TitleGuid): ContentType {
    return g.kind === 'movie' ? 'movie' : g.anime ? 'anime' : 'series';
  }

  seasonItems(show: Show): Dto[] {
    return show.seasons.map((s) =>
      seasonItem({ id: s.id, seriesId: show.id, seriesName: show.meta.name, number: s.number, episodeCount: s.episodes.length, poster: show.meta.seasonPosters?.[s.number] ?? show.meta.poster }, this.jf.who),
    );
  }

  episodeItems(show: Show, season?: number): Dto[] {
    const rt = runtimeTicks(show.meta.runtime);
    return show.episodes
      .filter((e) => season === undefined || e.season === season)
      .map((e) => this.episodeItem(show, e, rt));
  }

  episodeItem(show: Show, e: EpisodeView, rt: number | null = runtimeTicks(show.meta.runtime)): Dto {
    const item = episodeItem(
      {
        id: e.id,
        seriesId: show.id,
        seasonId: e.seasonId,
        seriesName: show.meta.name,
        season: e.season,
        episode: e.episode,
        video: e.video,
        certification: show.meta.certification,
        runtimeTicks: rt,
        backdrop: show.meta.background,
        logo: show.meta.logo,
      },
      this.jf.who,
    );
    item.MediaSources = [placeholderSource(e.id)];
    this.keyBook.set(e.id, show.keys);
    this.episodeBook.set(e.id,{show,episode:e});
    return item;
  }

  async episodeState(idx:WatchIndex,show:Show,episode:EpisodeView): Promise<{watched?:EpisodeMark;resume?:ResumeEntry}> {
    const local=idx.localEpisode(show.keys,episode.season,episode.episode);
    if(local) return local;
    const stateKey=`${show.id}:${episode.season}:${episode.episode}`;
    const cached=this.episodeStates.get(stateKey);
    if(cached) return cached;
    const task=(async()=>{
      const primary=trackerApi.primary(this.ctx);
      if(!primary) return idx.episode(show.keys,episode.season,episode.episode);
      const source=show.guid.source;
      const numbering=episode.video.numbering ?? (isAnimeSource(source) ? 'anime' : source==='tvdb' ? 'tvdb' : source==='tmdb' ? 'tmdb' : this.ctx.cfg.providers.series==='tvdb' ? 'tvdb':'tmdb');
      try {
        const queries=await trackerTargets(this.ctx,{kind:'episode' as const,watched:true,ids:bundleOf(show.guid,show.meta),season:episode.season,episode:episode.episode,numbering,animeEpisode:episode.video.trackerAnime},primary.name);
        if(!queries.length) return {};
        const states=queries.map(q=>idx.episode(bundleKeys(q.ids),q.season ?? 1,q.episode ?? 0));
        const watched=states.every(s=>s.watched) ? {plays:Math.min(...states.map(s=>s.watched!.plays)),lastAt:states.map(s=>s.watched!.lastAt).sort().at(-1)!}:undefined;
        return {watched,resume:states.find(s=>s.resume)?.resume};
      } catch { return {}; }
    })();
    this.episodeStates.set(stateKey,task);
    return task;
  }

  watch(): Promise<WatchIndex> {
    this.watchPromise ??= (async () => {
      try {
        return new WatchIndex(await trackerApi.snapshot(this.ctx));
      } catch (error) {
        if (this.ctx.env.DB) throw error;
        return new WatchIndex({ movies: [], episodes: [], shows: [], resume: [], fetchedAt: new Date().toISOString() });
      }
    })();
    return this.watchPromise;
  }

  async decorate(items: Dto[], shows: Map<string, Show> = new Map()): Promise<Dto[]> {
    if (!items.length) return items;
    const idx = await this.watch();
    for (const item of items) {
      const id = String(item.Id ?? '');
      const g = decodeGuid(id);
      if (!g || g.kind === 'view' || g.kind === 'misc') continue;
      const keys = this.keysOf(id, g);
      const rt = typeof item.RunTimeTicks === 'number' ? item.RunTimeTicks : null;
      if (g.kind === 'movie') {
        const st = idx.movie(keys);
        if (!st.watched && !st.resume) continue;
        const runtime = st.resume?.runtimeMs && st.resume.runtimeMs > 0 ? st.resume.runtimeMs * 10_000 : rt;
        item.UserData = userData(id, {
          played: Boolean(st.watched),
          playCount: st.watched?.plays ?? 0,
          positionTicks: st.resume?.positionMs !== undefined ? st.resume.positionMs * 10_000 : st.resume && runtime ? Math.round((runtime * st.resume.progress) / 100) : 0,
          runtimeTicks: runtime,
          lastPlayed: st.watched?.lastAt ?? st.resume?.at,
        });
        continue;
      }
      if (g.kind === 'episode') {
        const known=this.episodeBook.get(id);
        const st = known ? await this.episodeState(idx,known.show,known.episode) : idx.episode(keys, g.season ?? 1, g.episode ?? 0);
        if (!st.watched && !st.resume) continue;
        const runtime = st.resume?.runtimeMs && st.resume.runtimeMs > 0 ? st.resume.runtimeMs * 10_000 : rt;
        item.UserData = userData(id, {
          played: Boolean(st.watched),
          playCount: st.watched?.plays ?? 0,
          positionTicks: st.resume?.positionMs !== undefined ? st.resume.positionMs * 10_000 : st.resume && runtime ? Math.round((runtime * st.resume.progress) / 100) : 0,
          runtimeTicks: runtime,
          lastPlayed: st.watched?.lastAt ?? st.resume?.at,
        });
        continue;
      }
      const show = shows.get(g.kind === 'series' ? id : encodeGuid(parentSeriesOf(g)));
      if (!show) continue;
      const pool = show.episodes.filter((e) => isReleased(e.video) && (g.kind === 'series' || e.season === g.season));
      if (!pool.length) continue;
      let watched = 0;
      let lastAt = '';
      for (const e of pool) {
        const st = await this.episodeState(idx,show,e);
        if (st.watched) {
          watched++;
          if (st.watched.lastAt > lastAt) lastAt = st.watched.lastAt;
        }
      }
      const unplayed = pool.length - watched;
      item.UserData = userData(id, { played: unplayed === 0, playCount: unplayed === 0 ? 1 : 0, unplayed, lastPlayed: lastAt || undefined });
      (item.UserData as Dto).PlayedPercentage = (watched / pool.length) * 100;
    }
    return this.decoratePreferences(items);
  }

  guidOfBundle(ids: IdBundle, kind: 'movie' | 'series'): TitleGuid | null {
    let canonical: string | null = null;
    try {
      canonical = metaApi.canonicalId(ids, kind);
    } catch {
      canonical = null;
    }
    const root = canonical ? titleRoot(canonical) : null;
    if (root) return { kind, source: root.source, num: root.num, anime: isAnimeSource(root.source) };
    for (const k of bundleKeys(ids)) {
      const [source, num] = k.split(':') as [IdSource, string];
      return { kind, source, num: Number(num), anime: isAnimeSource(source) };
    }
    return null;
  }

  private async cachedShelf(name: string, idx: WatchIndex, build: () => Promise<{items: Dto[]; total: number}>): Promise<{items: Dto[]; total: number}> {
    const snapshot = idx.snapshot;
    const revision = await sha256(JSON.stringify({
      imported: trackerApi.primary(this.ctx) ? snapshot.fetchedAt : '',
      local: snapshot.local, resume: snapshot.resume, dropped: snapshot.dropped,
    }));
    const cacheKey = `jf-shelf:v1:${this.ctx.scope}:${this.ctx.profile?.id ?? ''}:${this.ctx.cacheRevision ?? this.ctx.cfgToken}:${this.jf.base}:${name}:${revision}`;
    const cached = await cacheGet<{items: Dto[]; total: number}>(cacheKey, this.ctx.origin);
    if (cached) {
      await this.decoratePreferences(cached.items);
      return cached;
    }
    const result = await build();
    // Playback changes produce a new revision; preferences are reapplied on reads.
    await cachePut(cacheKey, result, 30, this.ctx.origin);
    return result;
  }

  async resumeShelf(start: number, limit: number): Promise<{ items: Dto[]; total: number }> {
    const idx = await this.watch();
    return this.cachedShelf(`resume:${start}:${limit}`, idx, async () => {
      const rows = [...(idx.snapshot.resume ?? [])].filter((r) => (r.kind === 'movie' || !idx.isDropped(bundleKeys(r.ids))) && (r.progress > 0 || (r.positionMs ?? 0) > 0) && r.progress < 100).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const page = rows.slice(start, start + Math.min(limit, SHELF_LIMIT));
      const shows = new Map<string, Show>();
      const built = await mapLimit(page, SHELF_CONCURRENCY, async (row): Promise<Dto | null> => {
        const g = this.guidOfBundle(row.ids, row.kind === 'movie' ? 'movie' : 'series');
        if (!g) return null;
        if (g.kind === 'movie') {
          const meta = await this.meta(g);
          return meta ? this.titleItemOf(meta, g) : null;
        }
        const show = await this.show(g);
        if (!show || idx.isDropped(show.keys)) return null;
        shows.set(show.id, show);
        let ep = this.findEpisode(show, { ...g, kind: 'episode', season: row.season, episode: row.episode });
        const local=idx.localEpisode(show.keys,row.season ?? 1,row.episode ?? 0);
        if (!local) {
          if (!ep || (await this.episodeState(idx,show,ep)).resume !== row) {
            ep=undefined;
            for(const candidate of show.episodes) if ((await this.episodeState(idx,show,candidate)).resume===row) {ep=candidate;break;}
          }
        }
        return ep ? this.episodeItem(show, ep) : null;
      });
      const items = built.filter((x): x is Dto => Boolean(x));
      await this.decorate(items, shows);
      return { items, total: rows.length };
    });
  }

  async nextUpShelf(start: number, limit: number, opts: { includeResumable: boolean; includeRewatching: boolean }): Promise<{ items: Dto[]; total: number }> {
    const idx = await this.watch();
    return this.cachedShelf(`next:${start}:${limit}:${opts.includeResumable}:${opts.includeRewatching}`, idx, async () => {
      const shows = [...(idx.snapshot.shows ?? [])].filter(row => !idx.isDropped(bundleKeys(row.ids))).sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
      const page = shows.slice(start, start + Math.min(limit, SHELF_LIMIT));
      const loaded = new Map<string, Show>();
      const built = await mapLimit(page, SHELF_CONCURRENCY, async (row): Promise<Dto | null> => {
        const g = this.guidOfBundle(row.ids, 'series');
        if (!g) return null;
        const show = await this.show(g);
        if (!show || idx.isDropped(show.keys)) return null;
        loaded.set(show.id, show);
        const released = show.episodes.filter(e => isReleased(e.video) && e.season>0);
        const states=await mapLimit(released,8,e=>this.episodeState(idx,show,e));
        let cursor=-1,lastAt='';
        for(let i=0;i<states.length;i++) {
          const watched=states[i].watched;
          if(watched && watched.lastAt>=lastAt) {cursor=i;lastAt=watched.lastAt;}
        }
        const nextIndex=states.findIndex((s,i)=>i>cursor && !s.watched);
        const next=nextIndex>=0 ? released[nextIndex]:undefined;
        if (!next) {
          if (!opts.includeRewatching) return null;
          return released.length ? this.episodeItem(show,released[0]):null;
        }
        if (!opts.includeResumable && states[nextIndex].resume) return null;
        return this.episodeItem(show, next);
      });
      const items = built.filter((x): x is Dto => Boolean(x));
      await this.decorate(items, loaded);
      return { items, total: shows.length };
    });
  }

  async upcomingShelf(start: number, limit: number): Promise<{ items: Dto[]; total: number }> {
    const idx = await this.watch();
    const followed = new Map<string, IdBundle>();
    for (const s of idx.snapshot.shows ?? []) if (!idx.isDropped(bundleKeys(s.ids))) followed.set(bundleKeys(s.ids)[0] ?? JSON.stringify(s.ids), s.ids);
    for (const r of idx.snapshot.resume ?? []) if (r.kind === 'episode' && !idx.isDropped(bundleKeys(r.ids))) followed.set(bundleKeys(r.ids)[0] ?? JSON.stringify(r.ids), r.ids);
    const now = Date.now();
    const horizon = now + UPCOMING_DAYS * 86_400_000;
    const list = [...followed.values()].slice(0, 60);
    const seen=new Set<string>();
    const episodes: Array<{ at: number; item: Dto }> = [];
    await mapLimit(list, SHELF_CONCURRENCY, async (ids) => {
      const g = this.guidOfBundle(ids, 'series');
      const show = g ? await this.show(g) : null;
      if (!show || idx.isDropped(show.keys)) return;
      if(show.keys.some(k=>seen.has(k)))return;
      show.keys.forEach(k=>seen.add(k));
      for (const e of show.episodes) {
        const at = Date.parse(e.video.released ?? '');
        if (e.season>0 && e.episode===1 && Number.isFinite(at) && at >= now && at <= horizon) {episodes.push({ at, item: this.episodeItem(show, e) });break;}
      }
    });
    const watchlists=(await this.catalogs()).filter(c=>c.type==='movie'&&/(?:[.:])watchlist(?:[.:]|$)/.test(c.id));
    await mapLimit(watchlists,2,async cat=>{
      const page=await this.window(cat,0,100);
      for(const meta of page.items){
        const item=this.previewItem(meta,cat,cat.viewId);
        const at=Date.parse(String(item?.PremiereDate??''));
        if(item&&item.Type==='Movie'&&Number.isFinite(at)&&at>=now&&at<=horizon&&!seen.has(String(item.Id))){seen.add(String(item.Id));episodes.push({at,item});}
      }
    });
    episodes.sort((a, b) => a.at - b.at);
    const items = episodes.slice(start, start + limit).map((e) => e.item);
    return { items, total: episodes.length };
  }

  async latest(cat: CatalogRef, limit: number): Promise<Dto[]> {
    const { items } = await this.window(cat, 0, limit);
    const built = items.map((m) => this.previewItem(m, cat, cat.viewId)).filter((x): x is Dto => Boolean(x));
    return this.decorate(built);
  }

  async similar(g: TitleGuid, limit: number): Promise<Dto[]> {
    const meta = await this.meta(g);
    if (!this.ctx.tmdbKey || !meta?.ids?.tmdb) return [];
    const kind=g.kind==='movie'?'movie':'tv';
    let related = await tmdbList(this.ctx,kind,`/${kind}/${meta.ids.tmdb}/recommendations`,{language:this.ctx.cfg.language},1);
    if (!related.length) related = await tmdbList(this.ctx,kind,`/${kind}/${meta.ids.tmdb}/similar`,{language:this.ctx.cfg.language},1);
    const items=await applyAgeCap(this.ctx,kind==='movie'?'movie':'series',related.filter(m => m.id !== `tmdb:${meta.ids!.tmdb}`));
    const built=items.slice(0,limit).map(m=> {
      const guid=this.guidOfBundle({tmdb:Number(m.id.split(':')[1])},kind==='movie'?'movie':'series');
      return guid?this.titleItemOf(m as Meta,guid):null;
    }).filter((x):x is Dto=>x!==null);
    return this.decorate(built);
  }

  async search(term: string, wanted: Set<ItemType> | null, limit: number): Promise<Dto[]> {
    const ai=aiQuery(this.ctx,term);
    const types: Array<{ type: ContentType; kind: 'movie' | 'series' }> = [];
    if (!wanted || wanted.has('Movie')) types.push({ type: 'movie', kind: 'movie' });
    if (!wanted || wanted.has('Series')) types.push({ type: 'series', kind: 'series' });
    if (!types.length) return [];
    const pages = await Promise.all(
      types.map(async (t) => {
        try {
          return { t, items: ai?await aiSearch(this.ctx,t.type,ai):((await metaApi.searchMeta(this.ctx, t.type, term, { limit })) ?? []) };
        } catch {
          return { t, items: [] as MetaPreview[] };
        }
      }),
    );
    const seen = new Set<string>();
    const out: Dto[] = [];
    const depth = Math.max(0, ...pages.map((p) => p.items.length));
    for (let rank = 0; rank < depth && out.length < limit; rank++) {
      for (const page of pages) {
        const m = page.items[rank];
        if (!m?.id) continue;
        const nameKey = `${String(m.name ?? '').toLowerCase()}|${String(m.year ?? m.releaseInfo ?? '').slice(0, 4)}`;
        if (seen.has(String(m.id)) || seen.has(nameKey)) continue;
        seen.add(String(m.id));
        seen.add(nameKey);
        if (!this.allowed((m as Meta).certification)) continue;
        const fakeCat: CatalogRef = { id: 'search', type: page.t.type, name: 'Search', group: '', genres: [], searchable: true, browsable: false, viewId: '', hash: 0 };
        const item = this.previewItem(m, fakeCat, null);
        if (item) out.push(item);
      }
    }
    return this.decorate(out);
  }
}

export function includeTypesOf(list: string[]): Set<ItemType> | null {
  const wanted = new Set<ItemType>();
  for (const t of list) if (t === 'Movie' || t === 'Series' || t === 'Episode' || t === 'Season'||t==='BoxSet') wanted.add(t);
  return wanted.size ? wanted : null;
}

export function filterByType(items: Dto[], wanted: Set<ItemType> | null): Dto[] {
  if (!wanted) return items;
  return items.filter((i) => wanted.has(i.Type as ItemType)||i.Type==='BoxSet'&&wanted.has('Movie'));
}

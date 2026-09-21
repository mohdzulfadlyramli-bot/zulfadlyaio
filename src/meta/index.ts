import type { Ctx } from '../context';
import type { MetaProvider } from '../config/schema';
import { parseStremioId } from '../stremio/ids';
import type { ContentType, Meta, MetaPreview, MetaVideo } from '../stremio/types';
import { cachePut, memo } from '../util/cache';
import { mapLimit, uniq } from '../util/concurrency';
import { animeApi } from './anime/index';
import { mergeArtwork, type ProvidedArtwork } from './artwork';
import { cinemetaMeta, cinemetaSearch } from './cinemeta';
import { bridgeIds, bundleFromStremioId, isAnimeId } from './ids';
import { splitLanguageTag, tvdbLanguage } from './language';
import { allowsUnrated, passesAgeCap } from './rating';
import { artworkFromDetails, tmdbDetails, tmdbMeta, tmdbSearch, type TmdbKind } from './tmdb';
import { artworkFromRecord, hasTvdb, tvdbMeta, tvdbRecord, tvdbSearch } from './tvdb';
import { tvmazeAirDates, tvmazeMeta } from './tvmaze';
import type { IdBundle, MetaApi } from './types';
import { collectionMeta } from '../addon/collections';

const PROVIDER_ORDER: MetaProvider[] = ['tmdb', 'tvdb', 'tvmaze'];
const TTL_MOVIE = 12 * 3600;
const TTL_SERIES = 6 * 3600;
const TTL_MIN = 300;

function canonicalId(ids: IdBundle, type: ContentType): string | null {
  if (ids.imdb) return ids.imdb;
  if (ids.tmdb) return `tmdb:${ids.tmdb}`;
  if (ids.mal) return `mal:${ids.mal}`;
  if (ids.anilist) return `anilist:${ids.anilist}`;
  if (ids.kitsu) return `kitsu:${ids.kitsu}`;
  if (ids.anidb) return `anidb:${ids.anidb}`;
  if (ids.tvdb) return `tvdb:${ids.tvdb}`;
  if (ids.tvmaze) return `tvmaze:${ids.tvmaze}`;
  void type;
  return null;
}

function providerOrder(ctx: Ctx, type: ContentType): MetaProvider[] {
  const primary = type === 'movie' ? ctx.cfg.providers.movie : ctx.cfg.providers.series;
  return [primary, ...PROVIDER_ORDER.filter((p) => p !== primary), ...(primary === 'cinemeta' ? [] : ['cinemeta' as MetaProvider])];
}

function canServe(ctx: Ctx, provider: MetaProvider, type: ContentType, ids: IdBundle): boolean {
  switch (provider) {
    case 'tmdb': return !!ctx.tmdbKey && !!ids.tmdb;
    case 'tvdb': return hasTvdb(ctx) && !!ids.tvdb;
    case 'tvmaze': return type !== 'movie' && !!(ids.imdb || ids.tvdb || ids.tvmaze);
    case 'cinemeta': return !!ids.imdb;
    default: return false;
  }
}

async function providerMeta(ctx: Ctx, provider: MetaProvider, type: ContentType, ids: IdBundle, videoId: string, withEpisodes: boolean): Promise<Meta | null> {
  const kind: TmdbKind = type === 'movie' ? 'movie' : 'tv';
  let meta: Meta | null;
  switch (provider) {
    case 'tmdb': meta = await tmdbMeta(ctx, kind, ids.tmdb!, videoId, { withEpisodes }); break;
    case 'tvdb': meta = await tvdbMeta(ctx, type === 'movie' ? 'movie' : 'series', ids.tvdb!, videoId, { withEpisodes }); break;
    case 'tvmaze': meta = await tvmazeMeta(ctx, ids, videoId, { withEpisodes }); break;
    case 'cinemeta': meta = await cinemetaMeta(ctx, type, ids.imdb!); break;
    default: return null;
  }
  if (meta?.videos && (provider === 'tmdb' || provider === 'tvdb')) {
    meta.videos = meta.videos.map(video => ({ ...video, numbering: provider }));
  }
  return meta;
}

function fillGaps(into: Meta, from: Meta | null | undefined): Meta {
  if (!from) return into;
  const out: Meta = { ...into };
  const rec = out as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(from)) {
    if (k === 'id' || k === 'type' || v === undefined || v === null) continue;
    const cur = rec[k];
    const empty = cur === undefined || cur === null || cur === '' || (Array.isArray(cur) && cur.length === 0);
    if (empty && !(Array.isArray(v) && v.length === 0)) rec[k] = v;
  }
  out.ids = { ...(from.ids ?? {}), ...(into.ids ?? {}) };
  if (from.links?.length && into.links?.length) out.links = uniq([...into.links, ...from.links], (l) => `${l.category}:${l.url}`);
  return out;
}

function needsMore(meta: Meta, type: ContentType): boolean {
  if (type !== 'movie' && !(meta.videos?.length)) return true;
  return !meta.description || !meta.poster;
}

async function fillAirDates(ctx: Ctx, meta: Meta, ids: IdBundle): Promise<void> {
  const videos = meta.videos ?? [];
  const missing = videos.filter((v) => !v.released);
  if (!videos.length || !missing.length) return;
  const stamps = await tvmazeAirDates(ctx, ids);
  if (!stamps.size) return;
  for (const v of videos) {
    if (v.released || v.season === undefined || v.episode === undefined) continue;
    const s = stamps.get(`${v.season}:${v.episode}`);
    if (s) v.released = s;
  }
}

function nextAiring(videos: MetaVideo[] | undefined, now: number): number | null {
  let next: number | null = null;
  for (const v of videos ?? []) {
    const at = v.released ? Date.parse(v.released) : NaN;
    if (Number.isFinite(at) && at > now && (next === null || at < next)) next = at;
  }
  return next;
}

function metaTtl(meta: Meta, type: ContentType): number {
  if (type === 'movie') return TTL_MOVIE;
  const next = nextAiring(meta.videos, Date.now());
  if (next === null) return TTL_SERIES;
  const untilAir = Math.floor((next - Date.now()) / 1000) + 3600 + Math.floor(Math.random() * 900);
  return Math.max(TTL_MIN, Math.min(TTL_SERIES, untilAir));
}

function looksAnime(meta: Meta): boolean {
  const genres = (meta.genres ?? []).map((g) => g.toLowerCase());
  if (genres.includes('anime')) return true;
  const animation = genres.includes('animation');
  const japanese = /^(ja|jpn|japanese)$/i.test(meta.language || '') || /^(jp|japan)$/i.test(meta.country || '');
  return animation && japanese;
}

function stripByAgeCap(ctx: Ctx, meta: Meta): Meta | null {
  const cap = ctx.cfg.ageCap;
  if (!cap) return meta;
  return passesAgeCap(meta.certification, cap, allowsUnrated(ctx.cfg)) ? meta : null;
}

async function buildMeta(ctx: Ctx, type: ContentType, id: string): Promise<Meta | null> {
  if ((type === 'movie' ? ctx.cfg.providers.movie : ctx.cfg.providers.series) === 'off') return null;
  const parsed = parseStremioId(id);
  let ids = await bridgeIds(ctx, bundleFromStremioId(parsed.title), type);
  const videoId = canonicalId(ids, type) ?? parsed.title;

  const order = providerOrder(ctx, type).filter((p) => canServe(ctx, p, type, ids));
  if (!order.length) return null;

  const provided: ProvidedArtwork = {};
  let meta: Meta | null = null;
  const tried = new Set<MetaProvider>();
  for (const provider of order) {
    tried.add(provider);
    const m = await providerMeta(ctx, provider, type, ids, videoId, true);
    if (!m) continue;
    meta = m;
    break;
  }
  if (!meta) return null;
  ids = { ...ids, ...(meta.ids ?? {}) };

  for (const provider of order) {
    if (tried.has(provider) || !needsMore(meta, type)) continue;
    tried.add(provider);
    const wantEpisodes = type !== 'movie' && !meta.videos?.length;
    const extra = await providerMeta(ctx, provider, type, ids, videoId, wantEpisodes);
    if (extra) meta = fillGaps(meta, extra);
  }

  {
    const animeProvider = ctx.cfg.providers.anime;
    const usesAnimeSite = animeProvider === 'mal' || animeProvider === 'anilist' || animeProvider === 'kitsu';
    if (usesAnimeSite && looksAnime(meta) && (await animeApi.isAnime(ids, meta.genres))) {
      const mapped = await animeApi.mapAnimeIds(ctx, ids);
      const animeId = mapped.mal ? `mal:${mapped.mal}` : mapped.anilist ? `anilist:${mapped.anilist}` : mapped.kitsu ? `kitsu:${mapped.kitsu}` : null;
      const fromAnime = animeId ? await animeApi.animeMeta(ctx, animeId) : null;
      if (fromAnime) {
        ids = { ...ids, ...mapped };
        meta = fillGaps({ ...fromAnime, id, type: meta.type }, meta);
      }
    }
  }

  if (type !== 'movie') await fillAirDates(ctx, meta, ids);

  const lang = splitLanguageTag(ctx.cfg.language).lang;
  if (ctx.tmdbKey && ids.tmdb && ctx.cfg.artwork.posters.concat(ctx.cfg.artwork.backgrounds, ctx.cfg.artwork.logos).includes('tmdb')) {
    const d = await tmdbDetails(ctx, type === 'movie' ? 'movie' : 'tv', ids.tmdb);
    if (d) provided.tmdb = artworkFromDetails(d, lang);
  }
  if (hasTvdb(ctx) && ids.tvdb && ctx.cfg.artwork.posters.concat(ctx.cfg.artwork.backgrounds, ctx.cfg.artwork.logos).includes('tvdb')) {
    const rec = await tvdbRecord(ctx, type === 'movie' ? 'movie' : 'series', ids.tvdb);
    if (rec) provided.tvdb = artworkFromRecord(rec, type === 'movie' ? 'movie' : 'series', tvdbLanguage(ctx.cfg.language));
  }
  const art = await mergeArtwork(ctx, type, ids, provided);
  meta.poster = art.poster ?? meta.poster;
  meta.background = art.background ?? meta.background;
  meta.logo = art.logo ?? meta.logo;

  meta.id = parsed.title;
  meta.ids = { imdb: ids.imdb, tmdb: ids.tmdb, tvdb: ids.tvdb, tvmaze:ids.tvmaze, mal: ids.mal, anilist: ids.anilist, kitsu: ids.kitsu, anidb: ids.anidb };
  for (const k of Object.keys(meta.ids) as Array<keyof NonNullable<Meta['ids']>>) if (meta.ids[k] === undefined) delete meta.ids[k];
  if (type === 'movie') {
    meta.behaviorHints = { ...(meta.behaviorHints ?? {}), defaultVideoId: videoId, hasScheduledVideos: false };
  } else {
    const scheduled = meta.behaviorHints?.hasScheduledVideos ?? nextAiring(meta.videos, Date.now()) !== null;
    meta.behaviorHints = { ...(meta.behaviorHints ?? {}), defaultVideoId: null, hasScheduledVideos: scheduled };
    if (meta.videos) meta.videos.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
  }
  return meta;
}

async function resolveMeta(ctx: Ctx, type: ContentType, id: string): Promise<Meta | null> {
  if(/^(tvdbc|tmdbc):\d+$/.test(id))return collectionMeta(ctx,id);
  if (type === 'anime' || isAnimeId(id)) {
    const meta = await animeApi.animeMeta(ctx, id);
    return meta ? stripByAgeCap(ctx, meta) : null;
  }
  if (type !== 'movie' && type !== 'series') return null;
  const parsed = parseStremioId(id);
  if (parsed.source === 'other') return null;

  const key = `meta:v5:${ctx.scope}:${ctx.cacheRevision ?? ctx.cfgToken}:${type}:${parsed.title}`;
  const meta = await memo<Meta | null>(key, type === 'movie' ? TTL_MOVIE : TTL_SERIES, async () => {
    const built = await buildMeta(ctx, type, parsed.title);
    if (built && type !== 'movie') {
      const ttl = metaTtl(built, type);
      if (ttl < TTL_SERIES) await cachePut(key, built, ttl);
    }
    return built;
  });
  return meta ? stripByAgeCap(ctx, meta) : null;
}

function normName(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
}

async function searchMeta(ctx: Ctx, type: ContentType, query: string, opts: { skip?: number; limit?: number } = {}): Promise<MetaPreview[]> {
  const q = query.trim();
  if (!q) return [];
  const skip = Math.max(0, opts.skip ?? 0);
  const limit = Math.max(1, Math.min(100, opts.limit ?? 40));
  const page = Math.floor(skip / 20) + 1;

  if (type === 'anime') return animeApi.animeSearch(ctx, q, { skip, limit });
  if (type !== 'movie' && type !== 'series') return [];

  const providers = ctx.cfg.search.providers;
  const kind: TmdbKind = type === 'movie' ? 'movie' : 'tv';
  const wantsAnime = providers.some((p) => p === 'mal' || p === 'anilist' || p === 'kitsu');
  const tasks: Array<() => Promise<MetaPreview[]>> = [];
  const seenSource = new Set<string>();
  for (const p of providers) {
    if (seenSource.has(p === 'mal' || p === 'anilist' || p === 'kitsu' ? 'anime' : p)) continue;
    seenSource.add(p === 'mal' || p === 'anilist' || p === 'kitsu' ? 'anime' : p);
    switch (p) {
      case 'tmdb': if (ctx.tmdbKey) tasks.push(() => tmdbSearch(ctx, kind, q, page)); break;
      case 'tvdb': if (hasTvdb(ctx)) tasks.push(() => tvdbSearch(ctx, type === 'movie' ? 'movie' : 'series', q, { skip, limit: 20 })); break;
      case 'cinemeta': tasks.push(() => cinemetaSearch(ctx, type, q, { skip })); break;
      case 'mal': case 'anilist': case 'kitsu':
        if (wantsAnime && type === 'series') tasks.push(() => animeApi.animeSearch(ctx, q, { skip, limit: 20 }));
        break;
    }
  }
  const results = await mapLimit(tasks, 4, (t) => t().catch(() => [] as MetaPreview[]));

  const merged: MetaPreview[] = [];
  const maxLen = Math.max(0, ...results.map((r) => r.length));
  for (let i = 0; i < maxLen; i++) for (const list of results) if (list[i]) merged.push(list[i]);

  const seen = new Set<string>();
  const out: MetaPreview[] = [];
  for (const p of merged) {
    if (!p?.id || !p.name) continue;
    const keys = [p.id.toLowerCase(), `${normName(p.name)}:${p.year ?? ''}`];
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    out.push({ ...p, type: p.type === 'anime' ? 'series' : p.type });
  }
  return out.slice(0, limit);
}

async function resolveIds(ctx: Ctx, id: string, type?: ContentType): Promise<IdBundle> {
  const parsed = parseStremioId(id);
  let ids = bundleFromStremioId(parsed.title);
  if (isAnimeId(parsed.title)) {
    ids = await animeApi.mapAnimeIds(ctx, ids);
    if (ids.imdb || ids.tmdb || ids.tvdb || ids.tvmaze) ids = await bridgeIds(ctx, ids, type ?? (ids.tmdbType === 'movie' ? 'movie' : 'series'));
    return ids;
  }
  if (parsed.source === 'other') return ids;
  if (type) return bridgeIds(ctx, ids, type);
  const asSeries = await bridgeIds(ctx, ids, 'series');
  const asMovie = asSeries.tmdb || asSeries.tvdb ? asSeries : await bridgeIds(ctx, ids, 'movie');
  return asMovie;
}

export const metaApi: MetaApi = { resolveMeta, searchMeta, resolveIds, canonicalId };
export { canonicalId };

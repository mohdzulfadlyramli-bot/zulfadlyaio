import type { Ctx } from '../../context';
import type { AnimeApi, IdBundle } from '../types';
import type { Meta, MetaPreview } from '../../stremio/types';
import { parseStremioId } from '../../stremio/ids';
import { memo } from '../../util/cache';
import { mapLimit, uniq } from '../../util/concurrency';
import { anilistDetails, anilistMeta, anilistSearch, type AlMedia } from './anilist';
import { assembleEpisodes, franchiseEpisodes, gatherEpisodeRows } from './episodes';
import { kitsuDetails, kitsuMeta, kitsuSearch, type KitsuAnime } from './kitsu';
import { malDetails, malMeta, malSearch, type JikanAnime } from './mal';
import { isKnownAnime, mapAnimeIds, mappingForAnimeId, mappingsForExternal, pickRepresentative, type AnimeMapping } from './mapping';
import { animeKind, isoDate, type AnimeKind } from './shared';

export { malList } from './mal';
export { anilistList } from './anilist';
export { kitsuList } from './kitsu';
export { mapAnimeIds } from './mapping';

type Provider = 'mal' | 'anilist' | 'kitsu';
const META_TTL = 6 * 3600;

function providerOrder(ctx: Ctx): Provider[] {
  const pref = ctx.cfg.providers.anime;
  const first: Provider = pref === 'anilist' || pref === 'kitsu' ? pref : 'mal';
  return [first, ...(['mal', 'anilist', 'kitsu'] as Provider[]).filter((p) => p !== first)];
}

interface Records { mal: JikanAnime | null; anilist: AlMedia | null; kitsu: KitsuAnime | null }

async function fetchRecords(ctx: Ctx, ids: IdBundle): Promise<Records> {
  const jobs: Array<() => Promise<void>> = [];
  const out: Records = { mal: null, anilist: null, kitsu: null };
  if (ids.mal) jobs.push(async () => { out.mal = await malDetails(ctx, ids.mal!); });
  if (ids.anilist || ids.mal) jobs.push(async () => { out.anilist = await anilistDetails(ctx, { anilist: ids.anilist, mal: ids.mal }); });
  if (ids.kitsu) jobs.push(async () => { out.kitsu = await kitsuDetails(ctx, ids.kitsu!); });
  await mapLimit(jobs, 3, (j) => j().catch(() => undefined));
  return out;
}

function backfill(base: Meta, extra: Meta | null): void {
  if (!extra) return;
  const keys: Array<keyof Meta> = ['description', 'poster', 'background', 'logo', 'genres', 'imdbRating', 'releaseInfo', 'year', 'runtime', 'released', 'cast', 'director', 'writer', 'country', 'certification', 'trailers', 'status', 'network'];
  for (const k of keys) {
    const cur = base[k];
    const empty = cur === undefined || cur === null || cur === '' || (Array.isArray(cur) && cur.length === 0);
    const val = extra[k];
    const has = val !== undefined && val !== null && val !== '' && !(Array.isArray(val) && val.length === 0);
    if (empty && has) (base as unknown as Record<string, unknown>)[k] = val;
  }
  base.links = uniq([...(base.links || []), ...(extra.links || [])], (l) => `${l.category}|${l.name}`);
}

function kindOf(rec: Records): AnimeKind {
  return animeKind(rec.mal?.type || rec.anilist?.format || rec.kitsu?.res.attributes.subtype);
}

async function buildEntryMeta(ctx: Ctx, titleId: string, ids: IdBundle): Promise<Meta | null> {
  const rec = await fetchRecords(ctx, ids);
  const order = providerOrder(ctx);
  const metas: Record<Provider, Meta | null> = {
    mal: rec.mal ? malMeta(rec.mal, ctx.lang) : null,
    anilist: rec.anilist ? anilistMeta(rec.anilist, ctx.lang) : null,
    kitsu: rec.kitsu ? kitsuMeta(rec.kitsu, ctx.lang) : null,
  };
  const primary = order.find((p) => metas[p]);
  if (!primary) return null;
  const meta: Meta = { ...metas[primary]! };
  for (const p of order) if (p !== primary) backfill(meta, metas[p]);
  meta.id = titleId;
  meta.ids = { imdb: ids.imdb, tmdb: ids.tmdb, tvdb: ids.tvdb, mal: ids.mal, anilist: ids.anilist, kitsu: ids.kitsu, anidb: ids.anidb };

  const kind = kindOf(rec);
  if (kind === 'MOVIE') {
    meta.type = 'movie';
    meta.videos = undefined;
    meta.behaviorHints = { defaultVideoId: titleId, hasScheduledVideos: false };
    return meta;
  }
  meta.type = 'series';
  const rows = await gatherEpisodeRows(ctx, ids, { mal: rec.mal, anilist: rec.anilist, kitsu: rec.kitsu?.res.attributes }, primary);
  const count = rec.mal?.episodes ?? rec.anilist?.episodes ?? rec.kitsu?.res.attributes.episodeCount ?? null;
  const built = assembleEpisodes(titleId, {
    rows,
    count,
    firstAired: meta.released || isoDate(rec.kitsu?.res.attributes.startDate),
    weekly: kind === 'TV' || kind === 'ONA',
    fallbackThumb: meta.background,
  });
  meta.videos = built.videos;
  meta.behaviorHints = { defaultVideoId: null, hasScheduledVideos: built.hasFuture || meta.status === 'Currently Airing' || meta.status === 'releasing' };
  return meta;
}

async function buildFranchiseMeta(ctx: Ctx, titleId: string, ids: IdBundle, rows: AnimeMapping[]): Promise<Meta | null> {
  const parsed = parseStremioId(titleId);
  const wantMovie = ids.tmdbType === 'movie' ? true : ids.tmdbType === 'tv' ? false : rows.every((r) => r.kind === 'MOVIE') ? true : undefined;
  const lead = pickRepresentative(rows, wantMovie);
  if (!lead) return null;
  const leadIds: IdBundle = { mal: lead.mal, anilist: lead.anilist, kitsu: lead.kitsu, anidb: lead.anidb };
  const rec = await fetchRecords(ctx, leadIds);
  const order = providerOrder(ctx);
  const metas: Record<Provider, Meta | null> = {
    mal: rec.mal ? malMeta(rec.mal, ctx.lang) : null,
    anilist: rec.anilist ? anilistMeta(rec.anilist, ctx.lang) : null,
    kitsu: rec.kitsu ? kitsuMeta(rec.kitsu, ctx.lang) : null,
  };
  const primary = order.find((p) => metas[p]);
  if (!primary) return null;
  const meta: Meta = { ...metas[primary]! };
  for (const p of order) if (p !== primary) backfill(meta, metas[p]);
  meta.id = parsed.title;
  meta.ids = { imdb: ids.imdb, tmdb: ids.tmdb, tvdb: ids.tvdb, mal: lead.mal, anilist: lead.anilist, kitsu: lead.kitsu, anidb: lead.anidb };

  if (lead.kind === 'MOVIE') {
    meta.type = 'movie';
    meta.videos = undefined;
    meta.behaviorHints = { defaultVideoId: parsed.title, hasScheduledVideos: false };
    return meta;
  }
  meta.type = 'series';
  const built = await franchiseEpisodes(ctx, parsed.title, rows, meta.background);
  meta.videos = built.videos;
  meta.behaviorHints = { defaultVideoId: null, hasScheduledVideos: built.hasFuture };
  return meta;
}

async function animeMeta(ctx: Ctx, id: string): Promise<Meta | null> {
  if (ctx.cfg.providers.anime === 'off') return null;
  const parsed = parseStremioId(id);
  const titleId = parsed.title;
  const key = `anime:meta:v3:${ctx.lang}:${ctx.cfg.providers.anime}:${ctx.cfg.providers.series}:${ctx.tmdbKey?'t':''}:${ctx.cfg.keys.tvdb?'v':''}:${ctx.cfg.search.includeAdult ? 'a' : 's'}:${titleId}`;
  return memo<Meta | null>(key, META_TTL, async () => {
    if (parsed.source === 'mal' || parsed.source === 'anilist' || parsed.source === 'kitsu' || parsed.source === 'anidb') {
      const seed: IdBundle = { [parsed.source]: parsed.num } as IdBundle;
      const known = (await mappingForAnimeId(ctx, seed)) || null;
      const ids: IdBundle = { ...seed, ...(known ? { mal: known.mal, anilist: known.anilist, kitsu: known.kitsu, anidb: known.anidb, imdb: known.imdb, tmdb: known.tmdb, tvdb: known.tvdb } : {}) };
      const full = parsed.source === 'anidb' && !ids.mal && !ids.anilist && !ids.kitsu ? await mapAnimeIds(ctx, ids) : ids;
      if (!full.mal && !full.anilist && !full.kitsu) return null;
      return buildEntryMeta(ctx, titleId, full);
    }
    if (parsed.source === 'imdb' || parsed.source === 'tmdb' || parsed.source === 'tvdb') {
      const ext: IdBundle = parsed.source === 'imdb' ? { imdb: parsed.key } : parsed.source === 'tmdb' ? { tmdb: parsed.num } : { tvdb: parsed.num };
      const rows = await mappingsForExternal(ctx, ext);
      if (rows.length === 0) return null;
      return buildFranchiseMeta(ctx, titleId, ext, rows);
    }
    return null;
  });
}

async function animeSearch(ctx: Ctx, query: string, opts: { skip?: number; limit?: number } = {}): Promise<MetaPreview[]> {
  const wanted = ctx.cfg.search.providers.filter((p): p is Provider => p === 'mal' || p === 'anilist' || p === 'kitsu');
  const providers = wanted;
  const runners: Record<Provider, (c: Ctx, q: string, o: typeof opts) => Promise<MetaPreview[]>> = { mal: malSearch, anilist: anilistSearch, kitsu: kitsuSearch };
  const lists = await mapLimit(providers, 3, (p) => runners[p](ctx, query, opts).catch(() => [] as MetaPreview[]));
  const out: MetaPreview[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  const deduped = uniq(out, (m) => `${m.name.toLowerCase()}|${m.year || ''}`);
  return opts.limit ? deduped.slice(0, opts.limit) : deduped;
}

async function isAnime(ids: IdBundle, genres?: string[]): Promise<boolean> {
  if (ids.mal || ids.anilist || ids.kitsu || ids.anidb) return true;
  const g = (genres || []).map((x) => x.toLowerCase());
  if (g.includes('anime')) return true;
  const animated = g.includes('animation') || g.includes('animated');
  if (!animated && g.length > 0) return false;
  return isKnownAnime(ids);
}

export const animeApi: AnimeApi = { animeMeta, animeSearch, mapAnimeIds, isAnime };

import type { Ctx } from '../../context';
import type { IdBundle } from '../types';
import type { Meta, MetaLink, MetaPreview } from '../../stremio/types';
import { fetchJson, memo } from '../../util/cache';
import {
  animeKind, certFromAnilist, cleanSynopsis, dedupeStrings, isoDate, isoFromParts, parseSeasonParam, ratingLabel,
  releaseSpan, runtimeLabel, stableHash, stremioTypeFor, stripHtml, weekdayParam, WEEKDAYS,
} from './shared';

const ENDPOINT = 'https://graphql.anilist.co';
const TTL_DETAILS = 12 * 3600;
const TTL_LISTS = 3600;
const TTL_IDS = 7 * 24 * 3600;
const PAGE_SIZE = 25;

export interface AlDate { year?: number | null; month?: number | null; day?: number | null }
export interface AlTitle { romaji?: string | null; english?: string | null; native?: string | null }
export interface AlMedia {
  id: number;
  idMal?: number | null;
  title?: AlTitle;
  format?: string | null;
  status?: string | null;
  description?: string | null;
  startDate?: AlDate | null;
  endDate?: AlDate | null;
  season?: string | null;
  seasonYear?: number | null;
  episodes?: number | null;
  duration?: number | null;
  countryOfOrigin?: string | null;
  isAdult?: boolean | null;
  genres?: string[] | null;
  tags?: Array<{ name: string; rank?: number | null; isMediaSpoiler?: boolean | null }> | null;
  averageScore?: number | null;
  meanScore?: number | null;
  popularity?: number | null;
  coverImage?: { extraLarge?: string | null; large?: string | null; medium?: string | null; color?: string | null } | null;
  bannerImage?: string | null;
  trailer?: { id?: string | null; site?: string | null; thumbnail?: string | null } | null;
  siteUrl?: string | null;
  externalLinks?: Array<{ url: string; site: string; type?: string | null }> | null;
  studios?: { edges?: Array<{ isMain?: boolean; node: { id: number; name: string } }> } | null;
  characters?: { edges?: Array<{ role?: string | null; node: { name?: { full?: string | null } | null }; voiceActors?: Array<{ name?: { full?: string | null } | null }> }> } | null;
  staff?: { edges?: Array<{ role?: string | null; node: { name?: { full?: string | null } | null } }> } | null;
  relations?: { edges?: Array<{ relationType?: string | null; node: { id: number; idMal?: number | null; type?: string | null; format?: string | null; title?: AlTitle } }> } | null;
  streamingEpisodes?: Array<{ title?: string | null; thumbnail?: string | null; url?: string | null; site?: string | null }> | null;
  airingSchedule?: { nodes?: Array<{ episode: number; airingAt: number }> } | null;
  nextAiringEpisode?: { episode: number; airingAt: number } | null;
}
interface AlPage<T> { Page?: { pageInfo?: { hasNextPage?: boolean }; media?: T[]; airingSchedules?: Array<{ episode: number; airingAt: number; media: T }> } }

const PREVIEW_FIELDS = `
  id idMal format status description(asHtml: false) episodes duration isAdult genres averageScore popularity seasonYear
  title { romaji english native }
  startDate { year month day } endDate { year month day }
  coverImage { extraLarge large medium color } bannerImage`;

const DETAIL_FIELDS = `${PREVIEW_FIELDS}
  season countryOfOrigin meanScore siteUrl
  tags { name rank isMediaSpoiler }
  trailer { id site thumbnail }
  externalLinks { url site type }
  studios { edges { isMain node { id name } } }
  characters(sort: [ROLE, RELEVANCE], perPage: 12) { edges { role node { name { full } } voiceActors(language: JAPANESE) { name { full } } } }
  staff(sort: [RELEVANCE], perPage: 12) { edges { role node { name { full } } } }
  relations { edges { relationType node { id idMal type format title { romaji english } } } }
  streamingEpisodes { title thumbnail url site }
  airingSchedule(notYetAired: true, perPage: 25) { nodes { episode airingAt } }
  nextAiringEpisode { episode airingAt }`;

export async function anilistQuery<T>(ctx: Ctx, query: string, variables: Record<string, unknown>, ttl: number): Promise<T | null> {
  const key = `anime:anilist:q:v1:${await stableHash([query, variables])}`;
  const out = await memo<T | null>(key, ttl, async () => {
    const body = JSON.stringify({ query, variables });
    const res = await fetchJson<{ data?: T; errors?: unknown[] }>(ENDPOINT, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', accept: 'application/json', referer: ctx.origin || 'https://rill.invalid/' },
      timeoutMs: 15000,
    });
    return res?.data ?? null;
  });
  return out ?? null;
}

export async function anilistDetails(ctx: Ctx, ids: { anilist?: number; mal?: number }): Promise<AlMedia | null> {
  if (!ids.anilist && !ids.mal) return null;
  const arg = ids.anilist ? 'id: $id' : 'idMal: $idMal';
  const query = `query ($id: Int, $idMal: Int) { Media(${arg}, type: ANIME) { ${DETAIL_FIELDS} } }`;
  const data = await anilistQuery<{ Media?: AlMedia | null }>(ctx, query, ids.anilist ? { id: ids.anilist } : { idMal: ids.mal }, TTL_DETAILS);
  return data?.Media?.id ? data.Media : null;
}

export async function anilistIdsFor(ctx: Ctx, ids: { anilist?: number; mal?: number }): Promise<Partial<IdBundle>> {
  if (!ids.anilist && !ids.mal) return {};
  const arg = ids.anilist ? 'id: $id' : 'idMal: $idMal';
  const query = `query ($id: Int, $idMal: Int) { Media(${arg}, type: ANIME) { id idMal } }`;
  const data = await anilistQuery<{ Media?: { id: number; idMal?: number | null } | null }>(ctx, query, ids.anilist ? { id: ids.anilist } : { idMal: ids.mal }, TTL_IDS);
  const m = data?.Media;
  if (!m) return {};
  const out: Partial<IdBundle> = { anilist: m.id };
  if (m.idMal) out.mal = m.idMal;
  return out;
}

export async function anilistSearch(ctx: Ctx, text: string, opts: { skip?: number; limit?: number } = {}): Promise<MetaPreview[]> {
  const q = text.trim();
  if (!q) return [];
  const perPage = Math.min(50, Math.max(1, opts.limit || PAGE_SIZE));
  const page = Math.floor((opts.skip || 0) / perPage) + 1;
  const adult = ctx.cfg.search.includeAdult ? '' : ', isAdult: false';
  const query = `query ($search: String, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) { media(search: $search, type: ANIME, sort: SEARCH_MATCH${adult}) { ${PREVIEW_FIELDS} } } }`;
  const data = await anilistQuery<AlPage<AlMedia>>(ctx, query, { search: q, page, perPage }, TTL_LISTS);
  return (data?.Page?.media || []).map(anilistPreview);
}

export type AnilistListKind = 'trending' | 'popular' | 'top' | 'season' | 'upcoming' | 'airing' | 'genre' | 'tag' | 'schedule';

export async function anilistList(ctx: Ctx, kind: AnilistListKind, params: Record<string, string>, page: number): Promise<MetaPreview[]> {
  const p = Math.max(1, Math.floor(page || 1));
  const vars: Record<string, unknown> = { page: p, perPage: PAGE_SIZE };
  const filters: string[] = ['type: ANIME'];
  const decl: string[] = ['$page: Int', '$perPage: Int'];
  if (!ctx.cfg.search.includeAdult) filters.push('isAdult: false');
  if (params.format) { decl.push('$format: MediaFormat'); vars.format = params.format.toUpperCase(); filters.push('format: $format'); }
  else filters.push('format_not_in: [MUSIC]');

  if (kind === 'schedule') {
    const day = weekdayParam(params.day);
    const now = new Date();
    const todayIdx = (now.getUTCDay() + 6) % 7;
    const delta = (WEEKDAYS.indexOf(day) - todayIdx + 7) % 7;
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + delta) / 1000;
    const query = `query ($page: Int, $perPage: Int, $from: Int, $to: Int) {
      Page(page: $page, perPage: $perPage) { airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) { episode airingAt media { ${PREVIEW_FIELDS} } } } }`;
    const data = await anilistQuery<AlPage<AlMedia>>(ctx, query, { ...vars, from: start, to: start + 86400 }, TTL_LISTS);
    const seen = new Set<number>();
    return (data?.Page?.airingSchedules || [])
      .map((s) => s.media)
      .filter((m) => m && !seen.has(m.id) && seen.add(m.id) && (ctx.cfg.search.includeAdult || !m.isAdult))
      .map(anilistPreview);
  }

  let sort = 'POPULARITY_DESC';
  switch (kind) {
    case 'trending': sort = 'TRENDING_DESC'; break;
    case 'popular': sort = 'POPULARITY_DESC'; break;
    case 'top': sort = 'SCORE_DESC'; break;
    case 'season': {
      const s = parseSeasonParam(params.season);
      decl.push('$season: MediaSeason', '$seasonYear: Int');
      vars.season = s.season.toUpperCase(); vars.seasonYear = s.year;
      filters.push('season: $season', 'seasonYear: $seasonYear');
      break;
    }
    case 'upcoming': filters.push('status: NOT_YET_RELEASED'); break;
    case 'airing': filters.push('status: RELEASING'); break;
    case 'genre': if (!params.genre) return []; decl.push('$genre: String'); vars.genre = params.genre; filters.push('genre: $genre'); break;
    case 'tag': if (!params.tag) return []; decl.push('$tag: String'); vars.tag = params.tag; filters.push('tag: $tag'); break;
  }
  const query = `query (${decl.join(', ')}) { Page(page: $page, perPage: $perPage) { media(${filters.join(', ')}, sort: [${sort}, ID]) { ${PREVIEW_FIELDS} } } }`;
  const data = await anilistQuery<AlPage<AlMedia>>(ctx, query, vars, TTL_LISTS);
  return (data?.Page?.media || []).map(anilistPreview);
}

export function anilistTitle(m: AlMedia, lang?: string): string {
  const t = m.title || {};
  if (lang && lang.startsWith('ja') && t.native) return t.native;
  return t.english || t.romaji || t.native || `AniList ${m.id}`;
}

export function anilistPoster(m: AlMedia): string | undefined {
  return m.coverImage?.extraLarge || m.coverImage?.large || m.coverImage?.medium || undefined;
}

export function anilistGenres(m: AlMedia): string[] {
  const tags = (m.tags || []).filter((t) => !t.isMediaSpoiler && (t.rank ?? 0) >= 60).map((t) => t.name);
  return dedupeStrings([...(m.genres || []), ...tags]);
}

export function anilistPreview(m: AlMedia): MetaPreview {
  const kind = animeKind(m.format);
  const start = isoFromParts(m.startDate);
  return {
    id: `anilist:${m.id}`,
    type: stremioTypeFor(kind),
    name: anilistTitle(m),
    poster: anilistPoster(m),
    posterShape: 'poster',
    background: m.bannerImage || undefined,
    description: cleanSynopsis(stripHtml(m.description)),
    genres: anilistGenres(m),
    imdbRating: ratingLabel(m.averageScore, 100),
    releaseInfo: releaseSpan(start, isoFromParts(m.endDate), m.status === 'RELEASING', kind === 'MOVIE'),
    year: m.seasonYear || m.startDate?.year || undefined,
  };
}

function anilistLinks(m: AlMedia): MetaLink[] {
  const links: MetaLink[] = [];
  if (m.siteUrl) links.push({ name: 'AniList', category: 'External', url: m.siteUrl });
  for (const g of anilistGenres(m)) links.push({ name: g, category: 'Genres', url: `stremio:///search?search=${encodeURIComponent(g)}` });
  for (const e of m.studios?.edges || []) if (e.isMain) links.push({ name: e.node.name, category: 'Studios', url: `stremio:///search?search=${encodeURIComponent(e.node.name)}` });
  for (const e of m.relations?.edges || []) {
    if (e.node.type !== 'ANIME') continue;
    const name = e.node.title?.english || e.node.title?.romaji || String(e.node.id);
    const rel = (e.relationType || 'related').toLowerCase().replace(/_/g, ' ');
    links.push({ name: `${rel}: ${name}`, category: 'Related', url: `stremio:///detail/${stremioTypeFor(animeKind(e.node.format))}/anilist:${e.node.id}` });
  }
  for (const l of m.externalLinks || []) if (l.type === 'STREAMING') links.push({ name: l.site, category: 'Streaming', url: l.url });
  return links;
}

export function anilistMeta(m: AlMedia, lang?: string): Meta {
  const kind = animeKind(m.format);
  const base = anilistPreview(m);
  base.name = anilistTitle(m, lang);
  const cast = dedupeStrings((m.characters?.edges || []).map((e) => e.node.name?.full));
  const director = dedupeStrings((m.staff?.edges || []).filter((e) => /director/i.test(e.role || '')).map((e) => e.node.name?.full));
  const writer = dedupeStrings((m.staff?.edges || []).filter((e) => /(script|composition|original creator|writer)/i.test(e.role || '')).map((e) => e.node.name?.full));
  const ids: Meta['ids'] = { anilist: m.id };
  if (m.idMal) ids.mal = m.idMal;
  const meta: Meta = {
    ...base,
    runtime: runtimeLabel(m.duration),
    released: isoFromParts(m.startDate),
    certification: certFromAnilist(m.isAdult),
    country: m.countryOfOrigin || undefined,
    cast,
    director,
    writer,
    links: anilistLinks(m),
    trailers: m.trailer?.id && (m.trailer.site || '').toLowerCase() === 'youtube' ? [{ source: m.trailer.id, type: 'Trailer' }] : [],
    status: m.status ? m.status.toLowerCase().replace(/_/g, ' ') : undefined,
    network: (m.studios?.edges || []).find((e) => e.isMain)?.node.name,
    ids,
    videos: [],
  };
  if (kind === 'MOVIE') meta.behaviorHints = { defaultVideoId: `anilist:${m.id}`, hasScheduledVideos: false };
  return meta;
}

export function anilistEpisodeRows(m: AlMedia): Array<{ episode: number; title?: string; thumbnail?: string; released?: string }> {
  const byNumber = new Map<number, { episode: number; title?: string; thumbnail?: string; released?: string }>();
  const streaming = [...(m.streamingEpisodes || [])];
  streaming.forEach((s, i) => {
    const match = /^(?:episode|ep\.?)\s*(\d+)\s*[-:–]?\s*(.*)$/i.exec((s.title || '').trim());
    const n = match ? Number(match[1]) : i + 1;
    if (!Number.isFinite(n) || n <= 0) return;
    const title = match ? match[2].trim() : (s.title || '').trim();
    byNumber.set(n, { episode: n, title: title || undefined, thumbnail: s.thumbnail || undefined });
  });
  const dates = [...(m.airingSchedule?.nodes || [])];
  if (m.nextAiringEpisode) dates.push(m.nextAiringEpisode);
  for (const d of dates) {
    if (!d || !Number.isFinite(d.episode)) continue;
    const row = byNumber.get(d.episode) || { episode: d.episode };
    row.released = isoDate(d.airingAt);
    byNumber.set(d.episode, row);
  }
  return [...byNumber.values()].sort((a, b) => a.episode - b.episode);
}

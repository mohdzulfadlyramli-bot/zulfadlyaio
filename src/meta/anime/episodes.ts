import type { Ctx } from '../../context';
import type { MetaVideo } from '../../stremio/types';
import { episodeId } from '../../stremio/ids';
import { mapLimit } from '../../util/concurrency';
import { anilistDetails, anilistEpisodeRows, type AlMedia } from './anilist';
import { kitsuEpisodeRows, kitsuEpisodes, type KitsuAnimeAttrs } from './kitsu';
import { malDetails, malEpisodeRows, malEpisodes, type JikanAnime } from './mal';
import { type AnimeMapping } from './mapping';
import { isoDate } from './shared';
import { parseStremioId } from '../../stremio/ids';
import { tvdbEpisodes, episodeToVideo } from '../tvdb';
import { tmdbMeta } from '../tmdb';
import { loadEpisodeMaps,toExternalEpisodes,type EpisodeMap,type EpisodeSpace } from './episode-map';

export interface EpisodeRow {
  episode: number;
  title?: string;
  thumbnail?: string;
  released?: string;
  overview?: string;
  runtime?: number;
  filler?: boolean;
  recap?: boolean;
}

export interface EpisodeSources {
  rows: EpisodeRow[][];
  count?: number | null;
  firstAired?: string;
  weekly?: boolean;
  fallbackThumb?: string;
}

export interface BuiltEpisodes { videos: MetaVideo[]; hasFuture: boolean; lastAired?: string }

const WEEK_MS = 7 * 24 * 3600 * 1000;

export function assembleEpisodes(titleId: string, src: EpisodeSources, season?: number): BuiltEpisodes {
  const merged = new Map<number, EpisodeRow>();
  for (const list of src.rows) {
    for (const r of list) {
      if (!Number.isFinite(r.episode) || r.episode <= 0) continue;
      const cur = merged.get(r.episode) || { episode: r.episode };
      if (!cur.title && r.title) cur.title = r.title;
      if (!cur.thumbnail && r.thumbnail) cur.thumbnail = r.thumbnail;
      if (!cur.released && r.released) cur.released = r.released;
      if (!cur.overview && r.overview) cur.overview = r.overview;
      if (!cur.runtime && r.runtime) cur.runtime = r.runtime;
      if (r.filler) cur.filler = true;
      if (r.recap) cur.recap = true;
      merged.set(r.episode, cur);
    }
  }
  const known = merged.size ? Math.max(...merged.keys()) : 0;
  const total = Math.max(known, src.count && src.count > 0 ? src.count : 0);
  const now = Date.now();
  const first = src.firstAired ? new Date(src.firstAired).getTime() : NaN;
  let hasFuture = false;
  let lastAired: string | undefined;
  const videos: MetaVideo[] = [];
  for (let n = 1; n <= total; n++) {
    const r = merged.get(n) || { episode: n };
    let released = r.released;
    if (!released && src.weekly && Number.isFinite(first)) released = isoDate(first + (n - 1) * WEEK_MS);
    const ts = released ? new Date(released).getTime() : NaN;
    const future = Number.isFinite(ts) && ts > now;
    if (future) hasFuture = true;
    else if (released && (!lastAired || released > lastAired)) lastAired = released;
    const v: MetaVideo = {
      id: episodeId(titleId, season, n),
      title: r.title || `Episode ${n}`,
      season: season ?? 1,
      episode: n,
    };
    if (released) v.released = released;
    const thumb = r.thumbnail || src.fallbackThumb;
    if (thumb) v.thumbnail = thumb;
    const flags = [r.filler ? '[Filler]' : '', r.recap ? '[Recap]' : ''].filter(Boolean).join(' ');
    const overview = [flags, r.overview || ''].filter(Boolean).join(' ').trim();
    if (overview) v.overview = overview;
    videos.push(v);
  }
  return { videos, hasFuture, lastAired };
}

export interface TitleRecords { mal?: JikanAnime | null; anilist?: AlMedia | null; kitsu?: KitsuAnimeAttrs | null }

export async function gatherEpisodeRows(
  ctx: Ctx,
  ids: { mal?: number; anilist?: number; kitsu?: number },
  records: TitleRecords,
  primary: 'mal' | 'anilist' | 'kitsu',
): Promise<EpisodeRow[][]> {
  const tasks: Array<{ name: 'mal' | 'anilist' | 'kitsu'; run: () => Promise<EpisodeRow[]> }> = [];
  if (ids.mal) tasks.push({ name: 'mal', run: async () => malEpisodeRows(await malEpisodes(ctx, ids.mal!)) });
  if (ids.kitsu) tasks.push({ name: 'kitsu', run: async () => kitsuEpisodeRows(await kitsuEpisodes(ctx, ids.kitsu!), ctx.lang) });
  if (ids.anilist || ids.mal) {
    tasks.push({
      name: 'anilist',
      run: async () => {
        const m = records.anilist || (await anilistDetails(ctx, { anilist: ids.anilist, mal: ids.mal }));
        return m ? anilistEpisodeRows(m) : [];
      },
    });
  }
  const results = await mapLimit(tasks, 3, async (t) => ({ name: t.name, rows: await t.run().catch(() => [] as EpisodeRow[]) }));
  const order: Array<'mal' | 'anilist' | 'kitsu'> = [primary, ...(['mal', 'kitsu', 'anilist'] as const).filter((n) => n !== primary)];
  return order.map((n) => results.find((r) => r.name === n)?.rows || []).filter((r) => r.length > 0);
}

export function projectAnimeVideos(titleId:string,entry:AnimeMapping,built:MetaVideo[],maps:EpisodeMap[],space:EpisodeSpace,externalId:number):MetaVideo[] {
  if(!entry.anidb)return [];
  return built.flatMap(v=>toExternalEpisodes(maps,space,{anidb:entry.anidb!,season:1,episode:v.episode!})
    .filter(target=>target.id===externalId).map(target=>({...v,id:episodeId(titleId,target.season,target.episode),season:target.season,episode:target.episode,numbering:space,trackerAnime:undefined})));
}

export async function franchiseEpisodes(ctx: Ctx, titleId: string, rows: AnimeMapping[], fallbackThumb?: string): Promise<BuiltEpisodes> {
  const parsed=parseStremioId(titleId);
  const preferred=ctx.cfg.providers.series==='tvdb'?'tvdb':'tmdb';
  const space:EpisodeSpace=parsed.source==='tmdb'?'tmdb':parsed.source==='tvdb'?'tvdb':rows.some(r=>r[preferred])?preferred:preferred==='tmdb'?'tvdb':'tmdb';
  const externalId=parsed.source===space?parsed.num:rows.find(r=>r[space])?.[space];
  if(!externalId)return {videos:[],hasFuture:false};
  let official:MetaVideo[]=[];
  if(space==='tvdb'&&ctx.cfg.keys.tvdb)official=(await tvdbEpisodes(ctx,externalId)).map(e=>({...episodeToVideo(titleId,e,fallbackThumb),numbering:'tvdb'}));
  if(space==='tmdb'&&ctx.tmdbKey)official=(await tmdbMeta(ctx,'tv',externalId,titleId))?.videos?.map(v=>({...v,numbering:'tmdb'}))??[];
  if(official.length) {
    const dates=official.map(v=>v.released).filter((d):d is string=>!!d&&Number.isFinite(Date.parse(d)));
    return {videos:official,hasFuture:dates.some(d=>Date.parse(d)>Date.now()),lastAired:dates.filter(d=>Date.parse(d)<=Date.now()).sort().at(-1)};
  }
  const maps=await loadEpisodeMaps(ctx);
  const videos: MetaVideo[] = [];
  let hasFuture = false;
  let lastAired: string | undefined;
  for (const entry of rows.filter(r=>r.kind!=='MOVIE'&&r.kind!=='MUSIC'&&r.anidb&&maps.some(m=>m.anidb===r.anidb&&m[space]===externalId))) {
      const built = await singleEntryEpisodes(ctx, titleId, entry, 1, 0, fallbackThumb);
      videos.push(...projectAnimeVideos(titleId,entry,built.videos,maps,space,externalId));
      hasFuture = hasFuture || built.hasFuture;
      if (built.lastAired && (!lastAired || built.lastAired > lastAired)) lastAired = built.lastAired;
  }
  return { videos:[...new Map(videos.map(v=>[v.id,v])).values()].sort((a,b)=>a.season!-b.season!||a.episode!-b.episode!), hasFuture, lastAired };
}

async function singleEntryEpisodes(ctx: Ctx, titleId: string, entry: AnimeMapping, season: number, offset: number, fallbackThumb?: string): Promise<BuiltEpisodes> {
  const record = entry.mal ? await malDetails(ctx, entry.mal) : null;
  const rows = await gatherEpisodeRows(ctx, { mal: entry.mal, anilist: entry.anilist, kitsu: entry.kitsu }, { mal: record }, 'mal');
  const built = assembleEpisodes(titleId, {
    rows,
    count: record?.episodes ?? null,
    firstAired: isoDate(record?.aired?.from),
    weekly: entry.kind === 'TV',
    fallbackThumb,
  }, season);
  for (const v of built.videos) {
    v.trackerAnime = { mal: entry.mal, anilist: entry.anilist, kitsu: entry.kitsu, anidb: entry.anidb, episode: v.episode! };
    v.episode = (v.episode || 0) + offset;
    v.id = episodeId(titleId, season, v.episode);
  }
  return built;
}

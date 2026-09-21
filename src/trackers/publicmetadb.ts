import type { Ctx } from '../context';
import { emptySnapshot, sendRequest, clampPercent, isoOrNow, epoch } from './common';
import type { DropEvent, MarkEvent, ScrobbleEvent, Tracker, ResumeEntry, WatchSnapshot } from './types';
import { fetchJson } from '../util/cache';
import { metaApi } from '../meta/index';
import { mapLimit } from '../util/concurrency';
import type { ManifestCatalog, MetaPreview } from '../stremio/types';
import { sourcePreview } from '../addon/sources';

async function catalogs(ctx: Ctx): Promise<ManifestCatalog[]> {
  if (!ctx.cfg.keys.publicmetadb) return [];
  type Ref={id:string|number;name?:string;title?:string};
  const options={headers:{authorization:`Bearer ${ctx.cfg.keys.publicmetadb}`},ttl:600,cacheScope:ctx.scope};
  const lists:Ref[]=[];
  for(let page=1;page<=20;page++) {
    const data=await fetchJson<{lists?:Ref[];items?:Ref[];pagination?:{totalPages?:number;hasNextPage?:boolean}}>(`https://publicmetadb.com/api/external/lists?page=${page}&perPage=50`,options);
    const rows=data?.lists??data?.items??[];
    lists.push(...rows);
    if(!rows.length || data?.pagination?.hasNextPage===false || page>=(data?.pagination?.totalPages??Infinity) || rows.length<50) break;
  }
  const picks=await fetchJson<{catalogs?:Ref[];items?:Ref[]}>('https://publicmetadb.com/api/external/catalogs',options);
  const all=[{id:'resume',name:'Continue watching'},...lists.map(l=>({id:`list:${l.id}`,name:l.name||l.title||`List ${l.id}`})),...(picks?.catalogs??picks?.items??[]).map(p=>({id:`pick:${p.id}`,name:p.name||p.title||`Pick ${p.id}`})),...(ctx.cfg.lists.publicmetadb ?? []).map(id=>({id:`list:${id}`,name:`List ${id}`})),...(ctx.cfg.lists.publicmetadbPicks ?? []).map(id=>({id:`pick:${id}`,name:`Pick ${id}`}))];
  const refs=[...new Map(all.slice().reverse().map(r=>[r.id,r])).values()].reverse();
  return refs.flatMap(r => (['movie','series'] as const).map(type => ({id:`publicmetadb:${type}:${r.id}`,type,name:`PublicMetaDB ${r.name}`,extra:[{name:'skip'}]})));
}

async function catalogItems(ctx: Ctx, id: string, skip: number): Promise<MetaPreview[]> {
  if (!ctx.cfg.keys.publicmetadb) return [];
  const match=/^publicmetadb:(movie|series):(resume|list|pick)(?::(.+))?$/.exec(id);
  if (!match) return [];
  const type=match[1] as 'movie'|'series',kind=match[2],ref=match[3];
  if (kind!=='resume' && !ref) return [];
  if (kind==='resume' && skip>0) return [];
  type Row={tmdb_id:number;media_type:string;season?:number;episode?:number;title?:string};
  const selected:Row[]=[];
  for(let page=1;page<=100;page++) {
    const path=kind==='resume' ? '/resume' : kind==='list' ? `/lists/${encodeURIComponent(ref!)}/items?page=${page}&perPage=20` : `/catalogs/${encodeURIComponent(ref!)}/items?page=${page}`;
    const result=await fetchJson<{items?:Row[];pagination?:{hasNextPage?:boolean;totalPages?:number}}>(`https://publicmetadb.com/api/external${path}`,{headers:{authorization:`Bearer ${ctx.cfg.keys.publicmetadb}`},ttl:60,cacheScope:ctx.scope});
    if (!result) throw new Error('PublicMetaDB catalog unavailable');
    const raw=result.items??[];
    selected.push(...raw.filter(r=>(r.media_type==='movie'?'movie':'series')===type));
    if(kind==='resume'||!raw.length||result.pagination?.hasNextPage===false||page>=(result.pagination?.totalPages??Infinity)||selected.length>=skip+20||kind==='pick'&&page===5)break;
    if(page===100)throw new Error('PublicMetaDB list exceeds the supported window');
  }
  const rows=kind==='resume'?selected:selected.slice(skip,skip+20);
  const items=await mapLimit(rows,4,async row => {
    if(kind!=='resume')return sourcePreview(ctx,type,`tmdb:${row.tmdb_id}`,row.title??'Untitled');
    const meta=await metaApi.resolveMeta(ctx,type,`tmdb:${row.tmdb_id}`);
    if (!meta) return null;
    if (kind==='resume' && type==='series') {
      const video=meta.videos?.find(v=>v.season===row.season && v.episode===row.episode);
      if (video) return {...meta,name:`${meta.name} · S${row.season}E${row.episode}`,videos:[video],behaviorHints:{...meta.behaviorHints,defaultVideoId:video.id}};
    }
    return meta;
  });
  return items.filter((m):m is NonNullable<typeof m>=>m!==null);
}

function target(ev: MarkEvent | ScrobbleEvent) {
  if (!ev.ids.tmdb) throw new Error('PublicMetaDB requires a TMDB ID');
  if (ev.kind === 'series' || (ev.kind === 'episode' && (ev.season === undefined || !ev.episode))) throw new Error('PublicMetaDB requires an individual movie or episode');
  return { tmdb_id: ev.ids.tmdb, media_type: ev.kind === 'movie' ? 'movie' : 'tv', ...(ev.kind === 'episode' ? { season: ev.season, episode: ev.episode } : {}) };
}
async function write(ctx: Ctx, path: string, method: string, body?: unknown) {
  const r = await sendRequest(`https://publicmetadb.com/api/external${path}`, {
    method, headers: { authorization: `Bearer ${ctx.cfg.keys.publicmetadb}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok || (r.body as { success?: boolean } | null)?.success === false) throw new Error('PublicMetaDB write rejected');
}
async function mark(ctx: Ctx, ev: MarkEvent) {
  const body = target(ev);
  if (ev.watched) await write(ctx, '/watched?dedupe=true', 'POST', body);
  else {
    const params = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]));
    await write(ctx, `/watched?${params}`, 'DELETE');
  }
}
interface HistoryRow {
  id?: string; tmdb_id: number; media_type: string; season?: number; episode?: number;
  watched_at?: string; updated?: string; created?: string;
  position_ms?: number; runtime_ms?: number; progress?: number;
}
interface HistoryPage { items: HistoryRow[]; total?: number; totalPages?: number; page?: number; perPage?: number }

async function historyRows(ctx: Ctx, endpoint: 'watched' | 'resume', filter?: URLSearchParams): Promise<HistoryRow[]> {
  const rows: HistoryRow[] = [], seen = new Set<string>();
  for (let page = 1; page <= 100; page++) {
    const params = new URLSearchParams(filter);
    params.set('page', String(page)); params.set('perPage', '500');
    const response = await sendRequest(`https://publicmetadb.com/api/external/${endpoint}?${params}`, {
      headers: { authorization: `Bearer ${ctx.cfg.keys.publicmetadb}` },
    });
    const data = response.body as HistoryPage | null;
    if (!response.ok || !data || !Array.isArray(data.items)) throw new Error('PublicMetaDB history unavailable');
    const signature = JSON.stringify(data.items);
    if (data.items.length && seen.has(signature)) throw new Error('PublicMetaDB repeated a history page');
    seen.add(signature); rows.push(...data.items);
    if (typeof data.totalPages === 'number' && page >= data.totalPages || typeof data.total === 'number' && rows.length >= data.total) return rows;
    if (!data.items.length) {
      if (typeof data.total === 'number' && rows.length < data.total || typeof data.totalPages === 'number' && page < data.totalPages) throw new Error('PublicMetaDB returned incomplete history');
      return rows;
    }
    if (data.total === undefined && data.totalPages === undefined && data.items.length < (data.perPage ?? 500)) return rows;
  }
  throw new Error('PublicMetaDB history exceeds the import limit; previous history was retained');
}

function rowIdentity(row: HistoryRow): Pick<ResumeEntry, 'ids' | 'kind' | 'season' | 'episode'> | null {
  if (!Number.isInteger(row.tmdb_id) || row.tmdb_id <= 0) return null;
  if (row.media_type === 'movie') return { ids: { tmdb: row.tmdb_id, tmdbType: 'movie' }, kind: 'movie' };
  if (row.media_type !== 'tv' || !Number.isInteger(row.season) || row.season! < 0 || !Number.isInteger(row.episode) || row.episode! <= 0) return null;
  return { ids: { tmdb: row.tmdb_id, tmdbType: 'tv' }, kind: 'episode', season: row.season, episode: row.episode };
}

async function snapshot(ctx: Ctx): Promise<WatchSnapshot> {
  const [watched, resume, dropped] = await Promise.all([historyRows(ctx, 'watched'), historyRows(ctx, 'resume'), droppedShows(ctx)]);
  const out = emptySnapshot();
  out.dropped = dropped.map(tmdb => ({ tmdb, tmdbType: 'tv' }));
  const movies = new Map<number, WatchSnapshot['movies'][number]>(), episodes = new Map<string, WatchSnapshot['episodes'][number]>();
  const shows = new Map<number, WatchSnapshot['shows'][number]>(), plays = new Set<string>();
  for (const row of watched) {
    const item = rowIdentity(row); if (!item || row.id && plays.has(row.id)) continue;
    if (row.id) plays.add(row.id);
    const lastAt = isoOrNow(row.watched_at);
    if (item.kind === 'movie') {
      const old = movies.get(row.tmdb_id);
      movies.set(row.tmdb_id, { ids: item.ids, plays: (old?.plays ?? 0) + 1, lastAt: old && epoch(old.lastAt) > epoch(lastAt) ? old.lastAt : lastAt });
    } else {
      const key = `${row.tmdb_id}:${item.season}:${item.episode}`, old = episodes.get(key);
      episodes.set(key, { ids: item.ids, season: item.season!, episode: item.episode!, plays: (old?.plays ?? 0) + 1, lastAt: old && epoch(old.lastAt) > epoch(lastAt) ? old.lastAt : lastAt });
      const show = shows.get(row.tmdb_id);
      if (!show || epoch(lastAt) > epoch(show.lastAt)) shows.set(row.tmdb_id, { ids: item.ids, lastAt, lastSeason: item.season, lastEpisode: item.episode });
    }
  }
  out.movies = [...movies.values()]; out.episodes = [...episodes.values()]; out.shows = [...shows.values()];
  for (const row of resume) {
    const item = rowIdentity(row); if (!item) continue;
    const runtimeMs = Number(row.runtime_ms), positionMs = Number(row.position_ms);
    const progress = clampPercent(Number.isFinite(runtimeMs) && runtimeMs > 0 && Number.isFinite(positionMs) ? positionMs / runtimeMs * 100 : row.progress);
    if (progress <= 0 || progress >= 100) continue;
    out.resume.push({ ...item, progress, at: isoOrNow(row.updated ?? row.created), ref: row.id,
      ...(Number.isFinite(positionMs) && positionMs >= 0 ? { positionMs } : {}), ...(Number.isFinite(runtimeMs) && runtimeMs > 0 ? { runtimeMs } : {}) });
  }
  return out;
}

async function droppedShows(ctx: Ctx): Promise<number[]> {
  const ids: number[] = [], seen = new Set<string>();
  for (let page = 1; page <= 1000; page++) {
    const response = await sendRequest(`https://publicmetadb.com/api/external/dropped?page=${page}&perPage=100`, { headers: { authorization: `Bearer ${ctx.cfg.keys.publicmetadb}` } });
    const data = response.body as { items?: Array<{ tmdb_id: number }>; dropped?: Array<{ tmdb_id: number }>; totalPages?: number; total?: number; pagination?: { totalPages?: number; hasNextPage?: boolean; total?: number } } | null;
    const rows = Array.isArray(data) ? data as Array<{ tmdb_id: number }> : data?.items ?? data?.dropped;
    if (!response.ok || !Array.isArray(rows)) throw new Error('PublicMetaDB dropped shows unavailable');
    const signature = JSON.stringify(rows);
    if (rows.length && seen.has(signature)) throw new Error('PublicMetaDB repeated a dropped page');
    seen.add(signature);
    ids.push(...rows.map(row => Number(row.tmdb_id)).filter(id => Number.isSafeInteger(id) && id > 0));
    if (!rows.length || data?.pagination?.hasNextPage === false || page >= (data?.pagination?.totalPages ?? data?.totalPages ?? Infinity)) return ids;
  }
  throw new Error('PublicMetaDB dropped list exceeds the import limit');
}

async function drop(ctx: Ctx, ev: DropEvent): Promise<void> {
  if (!ev.ids.tmdb) throw new Error('PublicMetaDB requires a TMDB show ID');
  if (ev.dropped) { await write(ctx, '/dropped', 'POST', { tmdb_id: ev.ids.tmdb }); return; }
  const response = await sendRequest(`https://publicmetadb.com/api/external/dropped/${ev.ids.tmdb}/tv`, {
    method: 'DELETE', headers: { authorization: `Bearer ${ctx.cfg.keys.publicmetadb}` },
  });
  if (response.status !== 404 && (!response.ok || (response.body as { success?: boolean } | null)?.success === false)) throw new Error('PublicMetaDB undrop rejected');
}

async function clearResume(ctx: Ctx, entry: ResumeEntry): Promise<void> {
  if (entry.ref) { await write(ctx, `/resume/${encodeURIComponent(String(entry.ref))}`, 'DELETE'); return; }
  if (!entry.ids.tmdb) throw new Error('PublicMetaDB requires a TMDB ID to clear resume');
  const params = new URLSearchParams({ tmdb_id: String(entry.ids.tmdb), media_type: entry.kind === 'movie' ? 'movie' : 'tv' });
  if (entry.kind === 'episode') { params.set('season', String(entry.season)); params.set('episode', String(entry.episode)); }
  const rows = await historyRows(ctx, 'resume', params);
  for (const row of rows) {
    const item = rowIdentity(row);
    if (row.id && item?.ids.tmdb === entry.ids.tmdb && item.kind === entry.kind && item.season === entry.season && item.episode === entry.episode) await write(ctx, `/resume/${encodeURIComponent(row.id)}`, 'DELETE');
  }
}

export const publicmetadbTracker: Tracker = {
  name: 'publicmetadb', ready: ctx => !!ctx.cfg.keys.publicmetadb,
  snapshot,
  drop,
  clearResume,
  catalogs,
  catalogItems,
  mark,
  async scrobble(ctx, ev) {
    if (ev.action !== 'stop') return;
    const body = target(ev);
    if (ev.runtimeMs && ev.runtimeMs > 0) await write(ctx, '/resume', 'POST', {
      ...body, position_ms: Math.round(ev.runtimeMs * ev.progress / 100), runtime_ms: ev.runtimeMs,
    });
    if (ev.progress >= 90) await mark(ctx, { ...ev, watched: true });
  },
};

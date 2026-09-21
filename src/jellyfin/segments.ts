import type { Ctx } from '../context';
import type { IdBundle } from '../meta/types';
import { fetchJson } from '../util/cache';
export interface Segment { type:'Intro'|'Recap'|'Outro'; startMs:number; endMs:number }
export function segmentRange(type:Segment['type'],start:unknown,end:unknown):Segment|null {
  if(start===null||start===undefined||end===null||end===undefined) return null;
  const a=Math.max(0,Number(start)),b=Number(end);
  return Number.isFinite(a)&&Number.isFinite(b)&&b>a?{type,startMs:a,endMs:b}:null;
}
export async function segments(ctx:Ctx,ids:IdBundle,kind:'movie'|'episode',season?:number,episode?:number):Promise<Segment[]> {
  const found=new Map<Segment['type'],Segment>();
  const take=(s:Segment|null)=>{if(s&&!found.has(s.type))found.set(s.type,s);};
  if(ctx.cfg.keys.publicmetadb && ids.tmdb) {
    const p=new URLSearchParams({tmdb_id:String(ids.tmdb),media_type:kind==='movie'?'movie':'tv'});
    if(season!==undefined)p.set('season',String(season));if(episode!==undefined)p.set('episode',String(episode));
    const data=await fetchJson<{items?:Array<{source?:string;intro_start_ms?:number;intro_end_ms?:number;credits_start_ms?:number;credits_end_ms?:number}>}>(`https://publicmetadb.com/api/external/skips?${p}`,{ttl:86400,timeoutMs:5000,headers:{authorization:`Bearer ${ctx.cfg.keys.publicmetadb}`},cacheScope:ctx.scope});
    for(const row of (data?.items??[]).slice().sort((a,b)=>Number(b.source==='streaming')-Number(a.source==='streaming'))) {
      take(segmentRange('Intro',row.intro_start_ms,row.intro_end_ms));take(segmentRange('Outro',row.credits_start_ms,row.credits_end_ms));
    }
  }
  if(kind==='episode' && ids.imdb && season!==undefined && episode!==undefined) {
    const p=new URLSearchParams({imdb_id:ids.imdb,season:String(season),episode:String(episode)});
    const data=await fetchJson<Record<string,{start_ms?:number;end_ms?:number}>>(`https://api.introdb.app/segments?${p}`,{ttl:86400,timeoutMs:5000});
    for(const [key,type] of [['intro','Intro'],['recap','Recap'],['outro','Outro']] as const) take(segmentRange(type,data?.[key]?.start_ms,data?.[key]?.end_ms));
  }
  return [...found.values()];
}

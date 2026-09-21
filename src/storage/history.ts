import type { Ctx } from '../context';
import type { MarkEvent, ResumeEntry, ScrobbleEvent, WatchSnapshot } from '../trackers/types';
import { titleKey } from '../trackers/common';

interface LocalRecord {
  ids: ScrobbleEvent['ids']; kind: 'movie' | 'episode'; season?: number; episode?: number;
  progress: number; watched: boolean; at: string;
  positionMs?: number; runtimeMs?: number;
}

export function historyStatement(ctx: Ctx, ev: ScrobbleEvent | MarkEvent | ResumeEntry, mode: 'progress' | 'mark' | 'clear'): D1PreparedStatement | null {
  if (!ctx.env.DB || ev.kind === 'series') return null;
  const key = `${ev.kind}:${titleKey(ev.ids, ev.kind, ev.season, ev.episode)}`;
  const watched = mode === 'mark' ? (ev as MarkEvent).watched : mode === 'progress' && 'action' in ev && ev.action === 'stop' && ev.progress >= 90;
  const at = 'at' in ev && ev.at && Number.isFinite(Date.parse(ev.at)) ? ev.at : new Date().toISOString();
  const value: LocalRecord = {
    ids: ev.ids, kind: ev.kind, season: ev.season, episode: ev.episode,
    progress: mode === 'progress' && 'progress' in ev && !watched ? ev.progress : 0,
    watched, at,
    positionMs:mode === 'progress' && !watched && 'positionMs' in ev ? ev.positionMs : undefined,
    runtimeMs:'runtimeMs' in ev ? ev.runtimeMs : undefined,
  };
  const preserve = mode !== 'mark';
  return ctx.env.DB.prepare(`INSERT INTO history(scope,key,value,updated) VALUES(?,?,?,?) ON CONFLICT(scope,key) DO UPDATE SET
    value=CASE WHEN ? AND json_extract(history.value,'$.watched')=1 THEN json_set(excluded.value,'$.watched',json('true')) ELSE excluded.value END,
    updated=excluded.updated WHERE excluded.updated>=history.updated`).bind(ctx.historyScope ?? ctx.scope, key, JSON.stringify(value), Date.parse(at), preserve ? 1 : 0);
}

export async function saveHistory(ctx: Ctx, ev: ScrobbleEvent | MarkEvent | ResumeEntry, mode: 'progress' | 'mark' | 'clear'): Promise<void> {
  await historyStatement(ctx, ev, mode)?.run();
}

type Identified={ids:LocalRecord['ids'];season?:number;episode?:number};
function aliases(row:Identified,kind:string):string[] {
  return Object.entries(row.ids).filter(([k,v])=>k!=='tmdbType'&&v!==undefined).map(([k,v])=>`${kind}:${k}:${v}:${kind==='episode'?`${row.season}:${row.episode}`:''}`);
}
class Records<T extends Identified> {
  rows=new Set<T>(); index=new Map<string,Set<T>>();
  constructor(readonly kind:(row:T)=>string,rows:T[]=[],readonly keys?:Set<string>){for(const row of rows)this.add(row);}
  add(row:T){this.rows.add(row);for(const key of aliases(row,this.kind(row))){if(this.keys&&!this.keys.has(key))continue;const group=this.index.get(key)??new Set<T>();group.add(row);this.index.set(key,group);}}
  remove(row:Identified,kind:string):LocalRecord['ids'] {
    const found=new Set(aliases(row,kind).flatMap(k=>[...this.index.get(k)??[]]));
    const ids={...row.ids};
    for(const old of found){Object.assign(ids,old.ids,row.ids);this.rows.delete(old);for(const key of aliases(old,this.kind(old))){const group=this.index.get(key);group?.delete(old);if(!group?.size)this.index.delete(key);}}
    return ids;
  }
}

export async function overlayHistory(ctx: Ctx, base: WatchSnapshot): Promise<WatchSnapshot> {
  if (!ctx.env.DB) return base;
  const rows = await ctx.env.DB.prepare('SELECT value FROM history WHERE scope=? ORDER BY updated').bind(ctx.historyScope ?? ctx.scope).all<{ value: string }>();
  const out:WatchSnapshot = {...base,local:[]};
  if(rows.results.length) {
    const local = rows.results.map(row => JSON.parse(row.value) as LocalRecord);
    const keys = new Set(local.flatMap(row => aliases(row,row.kind)));
    const resume=new Records<ResumeEntry>(r=>r.kind,out.resume,keys);
    const movies=new Records<WatchSnapshot['movies'][number]>(()=>'movie',out.movies,keys);
    const episodes=new Records<WatchSnapshot['episodes'][number]>(()=>'episode',out.episodes,keys);
    for (const r of local) {
      r.ids={...resume.remove(r,r.kind),...(r.kind==='movie'?movies.remove(r,'movie'):episodes.remove(r,'episode'))};
      out.local!.push(r);
      if ((r.progress > 0 || (r.positionMs ?? 0) > 0) && r.progress < 100) resume.add({ ids:r.ids, kind:r.kind, season:r.season, episode:r.episode, progress:r.progress, positionMs:r.positionMs, runtimeMs:r.runtimeMs, at:r.at });
      if (r.kind === 'movie') {
        if (r.watched) movies.add({ ids:r.ids, plays:1, lastAt:r.at });
      } else {
        if (r.watched && r.season !== undefined && r.episode !== undefined) episodes.add({ ids:r.ids, season:r.season, episode:r.episode, plays:1, lastAt:r.at });
      }
    }
    out.movies=[...movies.rows];out.episodes=[...episodes.rows];out.resume=[...resume.rows];
  }
  let shows: WatchSnapshot['shows'] | undefined;
  return {
    ...out,
    resume: [...out.resume].sort((a,b) => b.at.localeCompare(a.at)),
    // Library rows need progress, but only shelves need the complete show list.
    get shows() { return shows ??= historyShows(out); },
  };
}

function historyShows(snapshot: WatchSnapshot): WatchSnapshot['shows'] {
  type Show=WatchSnapshot['shows'][number];
  const shows=new Set<Show>(),showIndex=new Map<string,Show>();
  const activity=[...snapshot.episodes,...snapshot.resume.filter(e=>e.kind==='episode')];
  const date=(e:typeof activity[number])=>'lastAt' in e?e.lastAt:e.at;
  activity.sort((a,b)=>date(a).localeCompare(date(b)));
  for(const e of activity) {
    let show:Show|undefined;
    for(const key of aliases(e,'series')) {
      const previous=showIndex.get(key);
      if(!previous || previous===show) continue;
      for(const alias of aliases(previous,'series')) showIndex.delete(alias);
      if(!show) show=previous;
      else {Object.assign(show.ids,previous.ids);shows.delete(previous);}
    }
    if(!show) show={ids:{},lastAt:date(e)};
    shows.delete(show);shows.add(show);
    Object.assign(show.ids,e.ids);
    show.lastAt=date(e);show.lastSeason=e.season;show.lastEpisode=e.episode;
    for(const key of aliases(show,'series')) showIndex.set(key,show);
  }
  return [...shows].sort((a,b) => b.lastAt.localeCompare(a.lastAt));
}

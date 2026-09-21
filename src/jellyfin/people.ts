import type { Ctx } from '../context';
import type { Meta, MetaPreview } from '../stremio/types';
import { tmdbGet,previewFromListItem,type TmdbListItem } from '../meta/tmdb';
import { fnv1a32,encodeGuid,personIdOf,type LabelGuid } from './ids';
export async function rememberPeople(ctx:Ctx,meta:Meta):Promise<void> {
  const names=[...new Set([...(meta.cast??[]),...(meta.director??[]),...(meta.writer??[])])].slice(0,40);
  if(!ctx.env.DB||!names.length)return;
  await ctx.env.DB.prepare(`INSERT INTO person_labels(id,name) VALUES ${names.map(()=>'(?,?)').join(',')} ON CONFLICT(id) DO NOTHING`).bind(...names.flatMap(name=>[personIdOf(name),name])).run();
}
export interface Person {id:number;name:string;profile_path?:string;biography?:string;birthday?:string;deathday?:string;place_of_birth?:string}
export async function personFor(ctx:Ctx,g:LabelGuid):Promise<Person|null> {
  if(g.kind!=='misc'||!ctx.tmdbKey)return null;
  if(g.sub==='tmdbperson' && g.hash > 0) return tmdbGet<Person>(ctx,`/person/${g.hash}`,{language:ctx.cfg.language},86400);
  if(g.sub!=='person')return null;
  const label=await ctx.env.DB?.prepare('SELECT name FROM person_labels WHERE id=?').bind(encodeGuid(g)).first<{name:string}>();
  const data=await tmdbGet<{results?:Person[]}>(ctx,'/search/person',{query:label?.name??g.hint.replace(/\uFFFD/g,''),language:ctx.cfg.language},86400);
  const person=data?.results?.find(p=>fnv1a32(p.name)===g.hash);
  if(!person)return null;
  return await tmdbGet<Person>(ctx,`/person/${person.id}`,{language:ctx.cfg.language},86400)??person;
}
export async function creditsFor(ctx:Ctx,id:number):Promise<MetaPreview[]> {
  const data=await tmdbGet<{cast?:Array<TmdbListItem&{media_type?:string}>;crew?:Array<TmdbListItem&{media_type?:string}>}>(ctx,`/person/${id}/combined_credits`,{language:ctx.cfg.language},86400);
  const rows=[...(data?.cast??[]),...(data?.crew??[])].filter(r=>(r.media_type==='movie'||r.media_type==='tv')&&(ctx.cfg.search.includeAdult||!r.adult));
  rows.sort((a,b)=>String(b.release_date||b.first_air_date||'').localeCompare(String(a.release_date||a.first_air_date||'')));
  return [...new Map(rows.map(r=>[`${r.media_type}:${r.id}`,previewFromListItem(r,r.media_type==='movie'?'movie':'tv')])).values()];
}

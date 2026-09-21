import type { Ctx } from '../context';
import type { Meta,MetaPreview } from '../stremio/types';
import { tvdbGet,artworkUrl } from '../meta/tvdb';
import { tmdbGet,previewFromListItem,type TmdbListItem } from '../meta/tmdb';
import { tvdbLanguageChain } from '../meta/language';
import { sourcePreview } from './sources';
import { mapLimit } from '../util/concurrency';

interface TvdbCollection {id:number;name?:string;overview?:string;image?:string;entities?:Array<{movieId?:number;order?:number}>}
export async function collectionMeta(ctx:Ctx,id:string):Promise<Meta|null> {
  const match=/^(tvdbc|tmdbc):(\d+)$/.exec(id);if(!match)return null;
  if(match[1]==='tmdbc') {
    const data=await tmdbGet<{id:number;name:string;overview?:string;poster_path?:string;backdrop_path?:string}>(ctx,`/collection/${match[2]}`,{language:ctx.cfg.language},86400);
    return data?{id,type:'movie',name:data.name,description:data.overview,poster:data.poster_path?`https://image.tmdb.org/t/p/w500${data.poster_path}`:undefined,background:data.backdrop_path?`https://image.tmdb.org/t/p/original${data.backdrop_path}`:undefined,collection:true}:null;
  }
  const data=await tvdbGet<TvdbCollection>(ctx,`/lists/${match[2]}/extended`,86400);if(!data)return null;
  let translated:{name?:string;overview?:string}|null=null;
  for(const language of tvdbLanguageChain(ctx.cfg.language)){translated=await tvdbGet(ctx,`/lists/${match[2]}/translations/${language}`,86400);if(translated?.name)break;}
  return{id,type:'movie',name:translated?.name??data.name??'Collection',description:translated?.overview??data.overview,poster:artworkUrl(data.image),collection:true};
}
export async function collectionMembers(ctx:Ctx,id:string,skip=0,limit=20):Promise<{items:MetaPreview[];total:number}> {
  const match=/^(tvdbc|tmdbc):(\d+)$/.exec(id);if(!match)return{items:[],total:0};
  if(match[1]==='tmdbc') {
    const data=await tmdbGet<{parts?:TmdbListItem[]}>(ctx,`/collection/${match[2]}`,{language:ctx.cfg.language},86400);
    if(!data)throw new Error('TMDB collection unavailable');
    const rows=(data.parts??[]).sort((a,b)=>(a.release_date||'9999').localeCompare(b.release_date||'9999'));
    return{items:rows.slice(skip,skip+limit).map(r=>previewFromListItem(r,'movie')),total:rows.length};
  }
  const data=await tvdbGet<TvdbCollection>(ctx,`/lists/${match[2]}/extended`,86400);if(!data)throw new Error('TVDB collection unavailable');
  const rows=(data.entities??[]).filter(r=>r.movieId).sort((a,b)=>(a.order??0)-(b.order??0));
  return{items:await mapLimit(rows.slice(skip,skip+limit),4,r=>sourcePreview(ctx,'movie',`tvdb:${r.movieId}`,'Untitled')),total:rows.length};
}
export async function collectionsPage(ctx:Ctx,skip:number):Promise<{items:MetaPreview[];consumed:number}> {
  const first=await tvdbGet<TvdbCollection[]>(ctx,'/lists?page=0',86400);if(!first)throw new Error('TVDB collections unavailable');
  if(!first.length)return{items:[],consumed:0};
  const page=Math.floor(skip/first.length),offset=skip%first.length;
  const rows=page?await tvdbGet<TvdbCollection[]>(ctx,`/lists?page=${page}`,86400):first;
  if(!rows)throw new Error('TVDB collections unavailable');
  const selected=rows.slice(offset,offset+20);
  const items=await mapLimit(selected,4,async row=>{
    const data=await tvdbGet<TvdbCollection>(ctx,`/lists/${row.id}/extended`,86400);
    if(!data?.entities?.some(e=>e.movieId))return null;
    return collectionMeta(ctx,`tvdbc:${row.id}`);
  });
  return{items:items.filter((m):m is Meta=>!!m),consumed:selected.length};
}

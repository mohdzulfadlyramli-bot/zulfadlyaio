import type { Ctx } from '../context';
import type { CustomCatalog } from '../config/schema';
import type { MetaPreview } from '../stremio/types';
import type { CatalogExtra } from './catalogs';
import { tmdbList } from '../meta/tmdb';
import { tvdbGet, artworkUrl, type TvdbRecord } from '../meta/tvdb';
import { malPreview, type JikanAnime } from '../meta/anime/mal';
import { anilistPreview, anilistQuery, type AlMedia } from '../meta/anime/anilist';
import { fetchJson } from '../util/cache';
import { socialItems } from './social-discovery';

export function discoverDate(value:string, now=new Date()):string {
  const match=/^\{?today(?:([+-])(\d+)([dwmy]))?\}?$/i.exec(value);
  if(!match) return value;
  const date=new Date(now),n=Number(match[2]??0)*(match[1]==='-'?-1:1);
  if(match[3]==='m') date.setUTCMonth(date.getUTCMonth()+n);
  else if(match[3]==='y') date.setUTCFullYear(date.getUTCFullYear()+n);
  else date.setUTCDate(date.getUTCDate()+n*(match[3]==='w'?7:1));
  return date.toISOString().slice(0,10);
}
export async function discoverItems(ctx:Ctx,c:CustomCatalog,extra:CatalogExtra):Promise<MetaPreview[]> {
  if(c.provider==='simkl')return await socialItems(ctx,c.type,`simkl.custom.${c.id}`,extra,c)??[];
  const skip=Math.max(0,extra.skip??0),p:Record<string,string>={};
  for(const [key,value] of Object.entries(c.params)) p[key]=discoverDate(Array.isArray(value)?value.join(','):String(value));
  if(c.provider==='tmdb') {
    if(c.type!=='movie')for(const k of Object.keys(p))if(k.startsWith('primary_release_date.')){p[k.replace('primary_release_date.','first_air_date.')]=p[k];delete p[k];}
    delete p.api_key;delete p.page;delete p.language;
    p.language=ctx.cfg.language;p.include_adult=ctx.cfg.search.includeAdult?'true':'false';
    if(extra.genre && /^\d+$/.test(extra.genre)) p.with_genres=extra.genre;
    return tmdbList(ctx,c.type==='movie'?'movie':'tv',`/discover/${c.type==='movie'?'movie':'tv'}`,p,Math.floor(skip/20)+1);
  }
  if(c.provider==='tvdb') {
    const allowed=['country','lang','sort','sortType','status','genre','year','company','contentRating'];
    const params=Object.fromEntries(Object.entries(p).filter(([k])=>allowed.includes(k)));
    params.country??='usa';params.lang??='eng';params.sort??='score';
    if(extra.genre && /^\d+$/.test(extra.genre)) params.genre=extra.genre;
    const rows=await tvdbGet<TvdbRecord[]>(ctx,`/${c.type==='movie'?'movies':'series'}/filter?${new URLSearchParams(params)}`,3600);
    return (rows??[]).slice(skip,skip+20).map(r=>({id:`tvdb:${r.id}`,type:c.type,name:r.name,poster:artworkUrl(r.image),description:r.overview,year:Number(r.year)||undefined}));
  }
  if(c.provider==='mal') {
    const allowed=['q','type','score','min_score','max_score','status','rating','genres','genres_exclude','order_by','sort','letter','producers','start_date','end_date'];
    const params=Object.fromEntries(Object.entries(p).filter(([k])=>allowed.includes(k)));
    params.page=String(Math.floor(skip/25)+1);params.limit='25';
    if(!ctx.cfg.search.includeAdult) params.sfw='true';
    if(extra.genre && /^\d+$/.test(extra.genre)) params.genres=extra.genre;
    const data=await fetchJson<{data:JikanAnime[]}>(`https://api.jikan.moe/v4/anime?${new URLSearchParams(params)}`,{ttl:3600});
    return (data?.data??[]).map(malPreview);
  }
  if(c.provider==='anilist') {
    const types:Record<string,string>={search:'String',format:'MediaFormat',format_in:'[MediaFormat]',status:'MediaStatus',season:'MediaSeason',seasonYear:'Int',genre:'String',genre_in:'[String]',genre_not_in:'[String]',tag_in:'[String]',tag_not_in:'[String]',minimumTagRank:'Int',sort:'[MediaSort]',countryOfOrigin:'CountryCode',episodes_greater:'Int',episodes_lesser:'Int',averageScore_greater:'Int',averageScore_lesser:'Int',popularity_greater:'Int',startDate_greater:'FuzzyDateInt',startDate_lesser:'FuzzyDateInt',isAdult:'Boolean'};
    const vars:Record<string,unknown>={page:Math.floor(skip/20)+1};
    const declarations=['$page:Int'],filters=['type:ANIME'];
    const values={...c.params,isAdult:ctx.cfg.search.includeAdult?c.params.isAdult??false:false,...(extra.genre?{genre:extra.genre}:{})};
    for(const [k,v] of Object.entries(values)) if(types[k]) {
      declarations.push(`$${k}:${types[k]}`);filters.push(`${k}:$${k}`);
      vars[k]=types[k]==='Int'||types[k]==='FuzzyDateInt'?Number(v):types[k]==='Boolean'?v===true||v==='true':types[k].startsWith('[')?Array.isArray(v)?v:String(v).split(','):v;
    }
    const data=await anilistQuery<{Page?:{media?:AlMedia[]}}>(ctx,`query(${declarations.join(',')}) { Page(page:$page,perPage:20) { media(${filters.join(',')}) { id idMal format status description episodes isAdult genres averageScore seasonYear title { romaji english native } startDate { year month day } coverImage { large extraLarge } bannerImage } } }`,vars,3600);
    return(data?.Page?.media??[]).map(anilistPreview);
  }
  return [];
}

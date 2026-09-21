import type { Ctx } from '../context';
import type { CatalogDefinition,CatalogExtra } from './catalogs';
import type { MetaPreview } from '../stremio/types';
import type { CustomCatalog } from '../config/schema';
import { fetchJson } from '../util/cache';
import { stremioIdOf } from '../trackers/common';
import type { IdBundle } from '../meta/types';

const skipExtra={name:'skip'};
export function socialDefinitions(ctx:Ctx):CatalogDefinition[] {
  const out:CatalogDefinition[]=[];
  if(ctx.cfg.trackers.trakt?.clientId)for(const type of ['movie','series'] as const) {
    for(const [kind,name] of [['trending','Trending'],['popular','Popular'],['anticipated','Anticipated']])out.push({id:`trakt.${kind}`,type,name,group:'Trakt discovery',extra:[skipExtra,{name:'genre'}]});
    for(const period of ['daily','weekly','monthly','all'])out.push({id:`trakt.favorited.${period}`,type,name:`Most favorited · ${period}`,group:'Trakt discovery',extra:[skipExtra,{name:'genre'}]});
  }
  for(const type of ['movie','series','anime'] as const) {
    out.push({id:'simkl.trending',type,name:'Trending',group:'Simkl discovery',extra:[skipExtra,{name:'genre',options:['Today','Week','Month']}]});
    if(type!=='movie')out.push({id:'simkl.calendar',type,name:'Airing soon',group:'Simkl discovery',extra:[skipExtra,{name:'genre',options:['Today','3 days','7 days']}]});
    for(const [recipe,name] of [['hiddengems','Hidden gems'],...(type==='movie'?[['quick','Under 100 minutes'],['boxoffice','Box office']]:[['marathon','Marathon']])])out.push({id:`simkl.recipe.${recipe}`,type,name,group:'Simkl recipes',extra:[skipExtra,{name:'genre',options:['Week','Today','Month']}]});
  }
  out.push({id:'simkl.dvd',type:'movie',name:'Latest DVD releases',group:'Simkl discovery',extra:[skipExtra]});
  return out;
}
interface SocialTitle {title?:string;name?:string;year?:number;poster?:string;overview?:string;genres?:string[];ids?:Record<string,string|number>;anime_type?:string;date?:string;rank?:number;ratings?:{simkl?:{rating?:number;votes?:number}};watched?:number;status?:string;total_episodes?:number;drop_rate?:string;runtime?:string;metadata?:string}
export function simklRecipe(rows:SocialTitle[],recipe:string):SocialTitle[] {
  const watched=rows.map(r=>Number(r.watched)||0).filter(n=>n>0).sort((a,b)=>a-b),median=watched[Math.floor(watched.length/2)]??0;
  const score=(r:SocialTitle)=>Number(r.ratings?.simkl?.rating)||0,votes=(r:SocialTitle)=>Number(r.ratings?.simkl?.votes)||0;
  const minutes=(r:SocialTitle)=>[...String(r.runtime??'').matchAll(/(\d+)\s*(h|m)/gi)].reduce((sum,m)=>sum+Number(m[1])*(m[2].toLowerCase()==='h'?60:1),0);
  const gross=(r:SocialTitle)=>{const m=/box office\s*\$?([\d.]+)\s*([kmb])?/i.exec(r.metadata??'');return m?Number(m[1])*({k:1e3,m:1e6,b:1e9}[m[2]?.toLowerCase()]??1):0;};
  const selected=rows.filter(r=>recipe==='hiddengems'?score(r)>=7.5&&votes(r)>=100&&(!median||(Number(r.watched)||0)<=median):recipe==='marathon'?r.status==='ended'&&Number(r.total_episodes)>=24&&(parseFloat(r.drop_rate??'0')||0)<=5:recipe==='quick'?minutes(r)>0&&minutes(r)<=100&&votes(r)>=30:recipe==='boxoffice'?gross(r)>0:false);
  return selected.sort((a,b)=>recipe==='boxoffice'?gross(b)-gross(a):score(b)-score(a)||(recipe==='hiddengems'?votes(b)-votes(a):(Number(b.watched)||0)-(Number(a.watched)||0)));
}
function preview(row:SocialTitle,type:'movie'|'series'|'anime'):MetaPreview|null {
  const ids:IdBundle={};
  for(const key of ['tmdb','tvdb','mal','anilist','kitsu','anidb'] as const){const n=Number(row.ids?.[key]);if(Number.isSafeInteger(n)&&n>0)ids[key]=n;}
  if(typeof row.ids?.imdb==='string'&&/^tt\d+$/.test(row.ids.imdb))ids.imdb=row.ids.imdb;
  const id=stremioIdOf(ids);if(!id)return null;
  const kind=type==='anime'?['movie','ona'].includes(row.anime_type??'')?'movie':'series':type;
  return Object.assign({id,type:kind,name:row.title||row.name||id,description:row.overview,genres:row.genres,year:row.year,poster:row.poster?/^https?:/.test(row.poster)?row.poster:`https://simkl.in/posters/${row.poster}_m.jpg`:ids.imdb?`https://images.metahub.space/poster/medium/${ids.imdb}/img`:undefined},{ids});
}
function cdnParams(ctx:Ctx):string {return new URLSearchParams({'app-name':'rill','app-version':'0.1.0',...(ctx.cfg.trackers.simkl?.clientId?{client_id:ctx.cfg.trackers.simkl.clientId}:{})}).toString();}
export async function socialItems(ctx:Ctx,type:'movie'|'series'|'anime',id:string,extra:CatalogExtra,custom?:CustomCatalog):Promise<MetaPreview[]|null> {
  const offset=Math.max(0,extra.skip??0);
  if(/^trakt\.(trending|popular|anticipated|favorited\.(daily|weekly|monthly|all))$/.test(id)) {
    const client=ctx.cfg.trackers.trakt?.clientId;if(!client||type==='anime')return [];
    const kind=type==='movie'?'movies':'shows',path=id.slice(6).replace('.','/');
    const params=new URLSearchParams({page:String(Math.floor(offset/20)+1),limit:'20',extended:'full',...(extra.genre?{genres:extra.genre.toLowerCase().replace(/\s+/g,'-')}:{})});
    const data=await fetchJson<Array<SocialTitle&{movie?:SocialTitle;show?:SocialTitle}>>(`https://api.trakt.tv/${kind}/${path}?${params}`,{ttl:3600,headers:{'trakt-api-version':'2','trakt-api-key':client}});
    if(!data)throw new Error('Trakt discovery is unavailable');
    return data.map(row=>preview(row.movie??row.show??row,type)).filter((m):m is MetaPreview=>m!==null);
  }
  let url='',rows:SocialTitle[]|null=null;
  const kind=type==='movie'?'movies':type==='series'?'tv':'anime';
  if(custom?.provider==='simkl') {
    const key=ctx.cfg.trackers.simkl?.clientId;if(!key)return [];
    const p=custom.params,segments=[extra.genre??p.genre??'all',p.type??'all-types',...(type==='anime'?[]:[p.country??'all-countries']),...(type==='movie'?[]:[p.network??'all-networks']),p.year??(type==='movie'?'this-year':'all-years'),p.sort??'popular-this-week'];
    url=`https://api.simkl.com/${kind}/genres/${segments.map(s=>encodeURIComponent(String(s).toLowerCase())).join('/')}?client_id=${encodeURIComponent(key)}`;
    rows=await fetchJson<SocialTitle[]>(url,{ttl:3600,headers:{'simkl-api-key':key}});
  } else if(id==='simkl.trending'||id.startsWith('simkl.recipe.')) {
    const interval=['today','week','month'].includes(extra.genre?.toLowerCase()??'')?extra.genre!.toLowerCase():id.startsWith('simkl.recipe.')?'week':'today';
    url=`https://data.simkl.in/discover/trending/${kind}/${interval}_500.json?${cdnParams(ctx)}`;
  } else if(id==='simkl.dvd')url=`https://data.simkl.in/discover/dvd/releases_500.json?${cdnParams(ctx)}`;
  else if(id==='simkl.calendar'&&type!=='movie')url=`https://data.simkl.in/calendar/${kind}.json?${cdnParams(ctx)}`;
  else return null;
  rows??=await fetchJson<SocialTitle[]>(url,{ttl:3600});
  if(!rows)throw new Error('Simkl discovery is unavailable');
  if(id.startsWith('simkl.recipe.'))rows=simklRecipe(rows,id.slice('simkl.recipe.'.length));
  if(id==='simkl.calendar') {
    const days=Math.min(7,Math.max(1,parseInt(extra.genre??'1')||1));
    const from=Date.parse(new Date().toISOString().slice(0,10)),until=from+days*86400_000;
    rows=rows.filter(r=>r.date&&Date.parse(r.date)>=from&&Date.parse(r.date)<until).sort((a,b)=>String(a.date).localeCompare(String(b.date))||(a.rank??0)-(b.rank??0));
  }
  return rows.map(r=>preview(r,type)).filter((m):m is MetaPreview=>m!==null).slice(offset,offset+20);
}

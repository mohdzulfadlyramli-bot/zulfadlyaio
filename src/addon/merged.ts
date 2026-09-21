import type { Meta, MetaPreview } from '../stremio/types';
import type { CustomCatalog } from '../config/schema';

export function catalogIdentities(m:MetaPreview):string[] {
  const ids=(m as Meta).ids;
  return [`${m.type}:${m.id}`,...Object.entries(ids??{}).filter(([k,v])=>k!=='tmdbType'&&v!==undefined).map(([k,v])=>`${m.type}:${k==='imdb'?'':k+':'}${v}`)];
}
type Page={items:MetaPreview[];consumed:number};
export async function mergedItems(
  sources:NonNullable<CustomCatalog['sources']>,skip:number,limit:number,
  read:(source:NonNullable<CustomCatalog['sources']>[number],offset:number)=>Promise<Page>,
):Promise<MetaPreview[]> {
  if(sources.some(s=>s.id.startsWith('merged.'))) throw new Error('A merged catalog cannot include another merged catalog');
  const cursors=sources.map(source=>({source,offset:0,items:[] as MetaPreview[],done:false,pages:0}));
  const seen=new Set<string>(),out:MetaPreview[]=[];
  let count=0;
  while(cursors.some(c=>!c.done||c.items.length) && count<skip+limit) {
    for(const c of cursors) {
      while(!c.items.length&&!c.done) {
        if(c.pages++>=64) throw new Error('Merged catalog source needs a narrower selection');
        const page=await read(c.source,c.offset);
        if(page.consumed<=0) {c.done=true;break;}
        c.offset+=page.consumed;c.items.push(...page.items);
      }
      while(c.items.length) {
        const item=c.items.shift()!,keys=catalogIdentities(item);
        if(keys.some(k=>seen.has(k))) {keys.forEach(k=>seen.add(k));continue;}
        keys.forEach(k=>seen.add(k));
        if(count++>=skip) out.push(item);
        break;
      }
      if(count>=skip+limit) break;
    }
  }
  return out;
}

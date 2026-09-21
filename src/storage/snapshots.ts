import type { Ctx } from '../context';
import type { WatchSnapshot } from '../trackers/types';
import { stateGet } from './state';

interface SnapshotHead { generation:string; parts:number }
export async function saveSnapshot(ctx:Ctx,key:string,snapshot:WatchSnapshot):Promise<void> {
  const db=ctx.env.DB;if(!db)return;
  const text=JSON.stringify(snapshot),generation=crypto.randomUUID(),expires=Date.now()+365*86400_000;
  const chunks:string[]=[];
  for(let at=0;at<text.length;at+=131072)chunks.push(text.slice(at,at+131072));
  const put=(k:string,value:unknown)=>db.prepare('INSERT INTO state(key,value,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires=excluded.expires').bind(k,JSON.stringify(value),expires);
  const old=await stateGet<SnapshotHead>(ctx,`${key}:head`);
  const statements=chunks.map((chunk,i)=>put(`${key}:part:${generation}:${i}`,chunk));
  statements.push(put(`${key}:head`,{generation,parts:chunks.length}));
  if(old?.generation)statements.push(db.prepare('DELETE FROM state WHERE key>=? AND key<?').bind(`${key}:part:${old.generation}:`,`${key}:part:${old.generation};`));
  await db.batch(statements);
}
export async function loadSnapshot(ctx:Ctx,key:string):Promise<WatchSnapshot|null> {
  const db=ctx.env.DB;if(!db)return null;
  const rows=await db.prepare(`WITH head AS (
    SELECT key,value,? || json_extract(value,'$.generation') AS prefix FROM state WHERE key=? AND expires>?
  ) SELECT key,value FROM head UNION ALL
    SELECT s.key,s.value FROM state s JOIN head h ON s.key>=(h.prefix || ':') AND s.key<(h.prefix || ';') WHERE s.expires>?`)
    .bind(`${key}:part:`,`${key}:head`,Date.now(),Date.now()).all<{key:string;value:string}>();
  const header=rows.results.find(r=>r.key===`${key}:head`);
  if(!header)return stateGet<WatchSnapshot>(ctx,key);
  const head=JSON.parse(header.value) as SnapshotHead,parts=new Map(rows.results.map(r=>[r.key,r.value]));
  const chunks=[];
  for(let i=0;i<head.parts;i++) {
    const value=parts.get(`${key}:part:${head.generation}:${i}`);
    if(value===undefined)throw new Error('Incomplete stored history import');
    chunks.push(JSON.parse(value) as string);
  }
  return JSON.parse(chunks.join('')) as WatchSnapshot;
}

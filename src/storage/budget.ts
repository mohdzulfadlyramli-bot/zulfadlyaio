export class DatabaseBudgetExceeded extends Error {
  constructor(){super('Database work will continue on the next scheduled run');}
}
interface Budget { used:number; limit:number; raw:D1Database }
const budgets=new WeakMap<D1Database,Budget>();
const originals=new WeakMap<object,D1PreparedStatement>();
function wrap(raw:D1Database,budget:Budget,cleanup=false):D1Database {
  const consume=(n:number)=>{if(budget.used+n>budget.limit-(cleanup?0:5))throw new DatabaseBudgetExceeded();budget.used+=n;};
  const statement=(s:D1PreparedStatement):D1PreparedStatement=> {
    const proxy=new Proxy(s,{get(target,key){
      if(key==='bind')return(...args:unknown[])=>statement(target.bind(...args));
      const value=Reflect.get(target,key);
      if(['first','all','run','raw'].includes(String(key)))return(...args:unknown[])=>{consume(1);return value.apply(target,args);};
      return typeof value==='function'?value.bind(target):value;
    }});
    originals.set(proxy,s);return proxy;
  };
  const db=new Proxy(raw,{get(target,key){
    if(key==='prepare')return(sql:string)=>statement(target.prepare(sql));
    if(key==='batch')return(statements:D1PreparedStatement[])=>{consume(statements.length);return target.batch(statements.map(s=>originals.get(s)??s));};
    if(key==='exec')return()=>{throw new Error('Use prepared statements for budgeted work');};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  budgets.set(db,budget);return db;
}
export function budgetDatabase(raw:D1Database,limit=50):D1Database {
  if(budgets.has(raw))return raw;
  return wrap(raw,{raw,used:0,limit});
}
export function hasDatabaseBudget(db:D1Database,needed:number):boolean {
  const b=budgets.get(db);return !b||b.limit-5-b.used>=needed;
}
export function cleanupDatabase(db:D1Database):D1Database {
  const b=budgets.get(db);return b?wrap(b.raw,b,true):db;
}

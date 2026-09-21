import { tryGetContext } from 'hono/context-storage';

const NS = 'https://rill.cache.invalid/';

function keyUrl(key: string, origin?: string): string {
  const requestUrl = tryGetContext()?.req.url;
  origin ??= requestUrl ? new URL(requestUrl).origin : undefined;
  return (origin ? `${origin}/.rill-cache/` : NS) + encodeURIComponent(key);
}

function cacheDatabase(): D1Database | undefined {
  return tryGetContext<{Bindings: {DB?: D1Database}}>()?.env.DB;
}

export async function cacheGet<T>(key: string, origin?: string): Promise<T | null> {
  const url = keyUrl(key, origin);
  try {
    const hit = await caches.default.match(url);
    if (hit) return await hit.json() as T;
  } catch {}
  try {
    const row = await cacheDatabase()?.prepare('SELECT value FROM state WHERE key=? AND expires>?')
      .bind(`cache:${url}`,Date.now()).first<{value:string}>();
    return row ? JSON.parse(row.value) as T : null;
  } catch { return null; }
}

export async function cachePut(key: string, value: unknown, ttlSeconds: number, origin?: string): Promise<void> {
  const url = keyUrl(key, origin);
  let json: string;
  try { json = JSON.stringify(value); } catch { return; }
  if (json === undefined) return;
  const ttl = Math.max(1,Math.floor(ttlSeconds));
  try {
    await caches.default.put(url, new Response(json, {
      headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` },
    }));
  } catch {}
  // workers.dev may not retain edge entries. Keep small results in the existing
  // database too; large history imports already have their own chunked storage.
  const db = cacheDatabase();
  if (db && json.length <= 64_000 && new TextEncoder().encode(json).byteLength <= 64_000) {
    try {
      await db.prepare('INSERT INTO state(key,value,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires=excluded.expires')
        .bind(`cache:${url}`,json,Date.now()+ttl*1000).run();
    } catch {}
  }
}

export async function cacheDelete(key: string, origin?: string, db = cacheDatabase()): Promise<void> {
  const url = keyUrl(key, origin);
  try { await caches.default.delete(url); } catch {}
  if (db) await db.prepare('DELETE FROM state WHERE key=?').bind(`cache:${url}`).run();
}

export async function memo<T>(key: string, ttlSeconds: number, produce: () => Promise<T>): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;
  const value = await produce();
  if (value !== undefined && value !== null) await cachePut(key, value, ttlSeconds);
  return value;
}

export interface FetchJsonOptions extends RequestInit {
  ttl?: number;
  timeoutMs?: number;
  cacheScope?: string;
}

export async function fetchJson<T = any>(url: string, opts: FetchJsonOptions = {}): Promise<T | null> {
  const { ttl = 0, timeoutMs = 12000, cacheScope = '', ...init } = opts;
  const method = (init.method || 'GET').toUpperCase();
  const key = `json:${cacheScope}:${url}`;
  if (method === 'GET' && ttl > 0) {
    const hit = await cacheGet<T>(key);
    if (hit !== null) return hit;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const data = (await res.json()) as T;
    if (method === 'GET' && ttl > 0 && data !== null && data !== undefined) await cachePut(key, data, ttl);
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

import type { Env } from '../env';

const SCOPE = 'rill:installation';
const SERVICE = 'updates';
const REQUEST_KEY = 'rill:update-request';
const COOLDOWN = 60_000;
const MONITOR_SERVICE = 'update-monitor';
const MONITOR_KEY = 'rill:update-monitor';

export class UpdateError extends Error {
  status: 400 | 503 | 502;
  constructor(message: string, status: 400 | 503 | 502 = 400) { super(message); this.status = status; }
}

interface Settings { hook: string; daily: boolean }
interface RequestRecord { id: string; requestedAt?: number; buildId?: string }
interface Monitor { accountId: string; worker: string; tag: string; token: string }
interface UpdateRun {
  id: string; source: string; requested_at: number; status: string; message: string;
  build_id: string | null; build_url: string | null; branch: string | null; finished_at: number | null; checked_at: number | null;
}
interface Build {
  build_uuid?: string; status?: string; build_outcome?: string; stopped_on?: string;
  build_trigger_metadata?: { branch?: string };
}

async function monitorSettings(env: Env): Promise<Monitor | null> {
  const row = await env.DB?.prepare('SELECT value FROM credentials WHERE scope=? AND service=?')
    .bind(SCOPE, MONITOR_SERVICE).first<{ value: string }>();
  return row ? JSON.parse(row.value) : null;
}

async function cloudflare<T>(monitor: Pick<Monitor, 'accountId' | 'token'>, path: string): Promise<T> {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${monitor.accountId}/${path}`, {
      headers: { Authorization: `Bearer ${monitor.token}` }, redirect: 'manual', signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new UpdateError('Cloudflare denied build status access. Check the read-only token and its account permissions.');
    }
    const body = await response.json<{ success?: boolean; result?: T }>();
    if (!response.ok || body.success !== true || body.result === undefined) throw new Error();
    return body.result;
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    throw new UpdateError('Build status is temporarily unavailable. Your update may still be running; check Cloudflare builds.', 502);
  }
}

export async function configureUpdateMonitor(env: Env, input: Record<string, unknown>): Promise<void> {
  const db = database(env);
  if (input.disconnect === true) {
    await db.prepare('DELETE FROM credentials WHERE scope=? AND service=?').bind(SCOPE, MONITOR_SERVICE).run();
    await db.prepare('DELETE FROM state WHERE key=?').bind(MONITOR_KEY).run();
    return;
  }
  const current = await monitorSettings(env);
  const accountId = typeof input.accountId === 'string' ? input.accountId.trim() : '';
  const worker = typeof input.worker === 'string' ? input.worker.trim() : '';
  const token = typeof input.token === 'string' && input.token.trim() ? input.token.trim() : current?.token || '';
  if (!/^[a-f0-9]{32}$/i.test(accountId) || !/^[a-zA-Z0-9_-]{1,63}$/.test(worker) || !/^[a-zA-Z0-9_-]{20,256}$/.test(token)) {
    throw new UpdateError('Enter your Cloudflare account ID, Worker name, and read-only API token.');
  }
  const scripts = await cloudflare<Array<{ id: string; tag: string }>>({ accountId, token }, 'workers/scripts');
  const tag = Array.isArray(scripts) ? scripts.find(script => script.id === worker)?.tag : null;
  if (!tag || !/^[a-zA-Z0-9_-]+$/.test(tag)) throw new UpdateError('That Worker was not found in this Cloudflare account.');
  const monitor: Monitor = { accountId, worker, tag, token };
  await cloudflare(monitor, `builds/workers/${tag}/builds?per_page=1`);
  await db.prepare('INSERT INTO credentials(scope,service,value) VALUES(?,?,?) ON CONFLICT(scope,service) DO UPDATE SET value=excluded.value')
    .bind(SCOPE, MONITOR_SERVICE, JSON.stringify(monitor)).run();
  await db.prepare('DELETE FROM state WHERE key=?').bind(MONITOR_KEY).run();
}

async function refreshBuilds(env: Env, monitor: Monitor): Promise<void> {
  const db = database(env), now = Date.now();
  const claim = await db.prepare(`INSERT INTO state(key,value,expires) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET expires=excluded.expires WHERE state.expires<=?`)
    .bind(MONITOR_KEY, '{}', now + 30_000, now).run();
  if (!claim.meta.changes) return;
  let error: string | null = null;
  try {
    const builds = await cloudflare<Build[]>(monitor, `builds/workers/${monitor.tag}/builds?per_page=100`);
    if (!Array.isArray(builds)) throw new Error();
    const records = await db.prepare('SELECT * FROM update_history WHERE build_id IS NOT NULL ORDER BY requested_at DESC LIMIT 30').all<UpdateRun>();
    const statements: D1PreparedStatement[] = [];
    for (const row of records.results) {
      const build = builds.find(build => build.build_uuid === row.build_id);
      if (!build) continue;
      const outcome = build.status === 'stopped' ? build.build_outcome : undefined;
      const status = outcome === 'success' ? 'succeeded' : outcome === 'fail' ? 'failed'
        : outcome === 'cancelled' || outcome === 'terminated' ? 'cancelled' : outcome === 'skipped' ? 'skipped'
        : ['queued', 'initializing', 'running'].includes(build.status || '') ? build.status! : 'unknown';
      const finished = build.status === 'stopped' && build.stopped_on ? Date.parse(build.stopped_on) : NaN;
      const buildUrl = `https://dash.cloudflare.com/${monitor.accountId}/workers/services/view/${encodeURIComponent(monitor.worker)}/production/builds/${encodeURIComponent(row.build_id!)}`;
      statements.push(db.prepare('UPDATE update_history SET status=?,message=?,finished_at=?,checked_at=?,branch=COALESCE(?,branch),build_url=? WHERE id=?')
        .bind(status, status === 'failed' ? 'Cloudflare reported a failed build. Open its build log for details.' : '',
          Number.isFinite(finished) ? finished : null, now, build.build_trigger_metadata?.branch?.slice(0, 200) || null, buildUrl, row.id));
    }
    if (statements.length) await db.batch(statements);
  } catch (cause) {
    error = cause instanceof UpdateError ? cause.message : 'Could not refresh build results. Check Cloudflare builds.';
  }
  await db.prepare('UPDATE state SET value=? WHERE key=?').bind(JSON.stringify({ checkedAt: now, error }), MONITOR_KEY).run();
}

export function validateUpdateHook(value: string): string {
  let hook: URL;
  try { hook = new URL(value.trim()); }
  catch { throw new UpdateError('Paste a valid Cloudflare Deploy Hook URL.'); }
  if (value.length > 512 || hook.origin !== 'https://api.cloudflare.com' || hook.username || hook.password || hook.search || hook.hash ||
    !/^\/client\/v4\/workers\/builds\/deploy_hooks\/[a-zA-Z0-9_-]+$/.test(hook.pathname)) {
    throw new UpdateError('Paste a valid Cloudflare Deploy Hook URL.');
  }
  return hook.href;
}

async function settings(env: Env): Promise<Settings> {
  const row = await env.DB?.prepare('SELECT value FROM credentials WHERE scope=? AND service=?')
    .bind(SCOPE, SERVICE).first<{ value: string }>();
  // Existing installations with the secret keep their daily update behavior.
  return row ? JSON.parse(row.value) as Settings : { hook: env.RILL_UPDATE_HOOK || '', daily: Boolean(env.RILL_UPDATE_HOOK) };
}

function database(env: Env): D1Database {
  if (!env.DB) throw new UpdateError('Updates need your installation database.', 503);
  return env.DB;
}

export async function updateStatus(env: Env) {
  const config = await settings(env);
  const monitor = await monitorSettings(env);
  if (monitor) await refreshBuilds(env, monitor);
  const row = await env.DB?.prepare('SELECT value,expires FROM state WHERE key=? AND expires>?')
    .bind(REQUEST_KEY, Date.now()).first<{ value: string; expires: number }>();
  const request = row ? JSON.parse(row.value) as RequestRecord : null;
  const history = await env.DB?.prepare('SELECT * FROM update_history ORDER BY requested_at DESC, id DESC LIMIT 30').all<UpdateRun>();
  const check = await env.DB?.prepare('SELECT value FROM state WHERE key=?').bind(MONITOR_KEY).first<{ value: string }>();
  const monitorStatus = check ? JSON.parse(check.value) as { checkedAt?: number; error?: string } : {};
  // Never return the hook. It is separate from account configs and exports.
  return { configured: Boolean(config.hook), daily: config.daily,
    retryAfter: row ? Math.max(0, Math.ceil((row.expires - Date.now()) / 1000)) : 0,
    requestedAt: request?.requestedAt ?? null,
    monitor: { configured: Boolean(monitor), accountId: monitor?.accountId || '', worker: monitor?.worker || '',
      checkedAt: monitorStatus.checkedAt || null, error: monitorStatus.error || null },
    history: (history?.results || []).map(run => ({ ...run,
      status: run.status === 'requesting' && Date.now() - run.requested_at > COOLDOWN ? 'unknown' : run.status,
      buildUrl: run.build_url,
    })) };
}

export async function configureUpdates(env: Env, hook: unknown, daily: unknown): Promise<void> {
  const db = database(env);
  if (typeof daily !== 'boolean' || (hook !== undefined && typeof hook !== 'string')) {
    throw new UpdateError('Choose your update settings and try again.');
  }
  const current = await settings(env);
  const value = typeof hook === 'string' && hook.trim() ? hook : current.hook;
  const config: Settings = { hook: validateUpdateHook(value), daily };
  await db.prepare('INSERT INTO credentials(scope,service,value) VALUES(?,?,?) ON CONFLICT(scope,service) DO UPDATE SET value=excluded.value')
    .bind(SCOPE, SERVICE, JSON.stringify(config)).run();
}

export async function disconnectUpdates(env: Env): Promise<void> {
  // An explicit disabled record also overrides a legacy environment secret.
  await database(env).prepare('INSERT INTO credentials(scope,service,value) VALUES(?,?,?) ON CONFLICT(scope,service) DO UPDATE SET value=excluded.value')
    .bind(SCOPE, SERVICE, JSON.stringify({ hook: '', daily: false })).run();
}

export async function requestUpdate(env: Env, source: 'manual' | 'daily' = 'manual') {
  const db = database(env);
  const config = await settings(env);
  if (!config.hook) throw new UpdateError('Connect updates first.');
  const hook = validateUpdateHook(config.hook);
  const now = Date.now(), id = crypto.randomUUID();
  const lease = JSON.stringify({ id });
  // Claim atomically across requests and Worker instances, including the cron.
  const claim = await db.prepare(`INSERT INTO state(key,value,expires) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires=excluded.expires WHERE state.expires<=?`)
    .bind(REQUEST_KEY, lease, now + COOLDOWN, now).run();
  if (!claim.meta.changes) return { alreadyRequested: true, ...await updateStatus(env) };
  let accepted = false;
  let failure = 'Cloudflare did not confirm the request. Check its builds before trying again.';
  let failureStatus = 'unknown';
  try {
    await db.prepare('INSERT INTO update_history(id,source,requested_at,status) VALUES(?,?,?,?)').bind(id, source, now, 'requesting').run();
    const response = await fetch(hook, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      failure = response.status === 429 ? 'Cloudflare is limiting update requests. Wait a minute, then try again.'
        : response.status === 404 || response.status === 401 || response.status === 403 ? 'Cloudflare rejected the hook. Reconnect it in Update settings.'
        : `Cloudflare rejected the request (HTTP ${response.status}). Check its builds and try again.`;
      failureStatus = 'request_failed';
      throw new Error();
    }
    const result = await response.json<{ success?: boolean; result?: { build_uuid?: string; branch?: string; already_exists?: boolean } }>();
    if (result.success !== true) {
      failure = 'Cloudflare did not accept the update request. Check your Deploy Hook.';
      failureStatus = 'request_failed';
      throw new Error();
    }
    accepted = true;
    const record: RequestRecord = { id, requestedAt: now };
    if (typeof result.result?.build_uuid === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(result.result.build_uuid)) record.buildId = result.result.build_uuid;
    await db.batch([
      db.prepare('UPDATE state SET value=? WHERE key=? AND value=?').bind(JSON.stringify(record), REQUEST_KEY, lease),
      db.prepare('UPDATE update_history SET status=?,build_id=?,branch=?,message=? WHERE id=?')
        .bind('accepted', record.buildId || null, result.result?.branch?.slice(0, 200) || null,
          result.result?.already_exists ? 'Cloudflare reused an already queued build.' : '', id),
      db.prepare('DELETE FROM update_history WHERE id NOT IN (SELECT id FROM update_history ORDER BY requested_at DESC, id DESC LIMIT 30)'),
    ]);
  } catch {
    if (accepted) throw new UpdateError('Cloudflare accepted the update, but Rill could not save its result. Check Cloudflare builds before retrying.', 502);
    if (failureStatus === 'request_failed') await db.prepare('DELETE FROM state WHERE key=? AND value=?').bind(REQUEST_KEY, lease).run();
    await db.batch([
      db.prepare('UPDATE update_history SET status=?,message=?,finished_at=? WHERE id=?')
        .bind(failureStatus, failure, failureStatus === 'request_failed' ? Date.now() : null, id),
      db.prepare('DELETE FROM update_history WHERE id NOT IN (SELECT id FROM update_history ORDER BY requested_at DESC, id DESC LIMIT 30)'),
    ]);
    throw new UpdateError(failure, 502);
  }
  return { alreadyRequested: false, ...await updateStatus(env) };
}

// Reuse the existing minute trigger; scheduledTime is UTC, even if delayed.
export async function dailyUpdate(event: Pick<ScheduledController, 'scheduledTime'>, env: Env): Promise<void> {
  if (!env.DB || Math.floor(event.scheduledTime / 60_000) % 1440 !== 4 * 60 + 17) return;
  const config = await settings(env);
  if (!config.hook || !config.daily) return;
  validateUpdateHook(config.hook);
  const key = `rill:daily-update:${Math.floor(event.scheduledTime / 86_400_000)}`;
  const claim = await env.DB.prepare('INSERT OR IGNORE INTO state(key,value,expires) VALUES(?,?,?)')
    .bind(key, 'true', Date.now() + 2 * 86_400_000).run();
  if (!claim.meta.changes) return;
  try {
    await requestUpdate(env, 'daily');
    console.log('Daily Rill update build requested. Check Cloudflare build history for the result.');
  } catch (error) {
    await env.DB.prepare('DELETE FROM state WHERE key=?').bind(key).run();
    throw error;
  }
}

import { credentials } from '../storage/credentials';
import type { Ctx } from '../context';
import type { TraktAuth } from '../config/schema';
import type { IdBundle } from '../meta/types';
import type { ManifestCatalog, MetaPreview } from '../stremio/types';
import { fetchJson } from '../util/cache';
import { clampPercent, emptySnapshot, epoch, fingerprint, isoOrNow, nowIso, sendRequest, stremioIdOf } from './common';
import type { DropEvent, MarkEvent, ResumeEntry, ScrobbleEvent, Tracker, WatchSnapshot, WatchedEpisode, WatchedMovie } from './types';

const API = 'https://api.trakt.tv';
const PAGE = 50;
const MIN_SCROBBLE = 1;

interface TraktIds { trakt?: number; slug?: string; imdb?: string; tmdb?: number; tvdb?: number }
interface TraktMovie { title?: string; year?: number; ids: TraktIds; overview?: string; genres?: string[]; images?: TraktImages }
interface TraktShow { title?: string; year?: number; ids: TraktIds; overview?: string; genres?: string[]; images?: TraktImages }
interface TraktImages { poster?: string[]; fanart?: string[]; logo?: string[]; thumb?: string[] }
interface TraktEpisodeRef { season: number; number: number; ids?: TraktIds }

interface PlaybackItem {
  id: number;
  progress: number;
  paused_at: string;
  type: 'movie' | 'episode';
  movie?: TraktMovie;
  show?: TraktShow;
  episode?: TraktEpisodeRef;
}
interface WatchedMovieItem { plays: number; last_watched_at: string; movie: TraktMovie }
interface WatchedShowItem {
  plays: number;
  last_watched_at: string;
  show: TraktShow;
  seasons?: Array<{ number: number; episodes?: Array<{ number: number; plays: number; last_watched_at: string }> }>;
}
interface ListEntry { type?: string; movie?: TraktMovie; show?: TraktShow }
interface UserList { name: string; ids: { trakt: number; slug: string } }

interface Session {
  token: string;
}

function auth(ctx: Ctx): TraktAuth | undefined {
  const a = ctx.cfg.trackers.trakt;
  return a && a.clientId && a.accessToken ? a : undefined;
}

async function session(ctx: Ctx): Promise<Session | null> {
  const a = auth(ctx);
  return a ? { token: (await credentials(ctx, 'trakt', a)).accessToken } : null;
}

function headers(ctx: Ctx, token: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': auth(ctx)?.clientId ?? '',
    authorization: `Bearer ${token}`,
  };
}

async function get<T>(ctx: Ctx, s: Session, path: string, ttl: number): Promise<T | null> {
  const result = await fetchJson<T>(`${API}${path}`, { headers: headers(ctx, s.token), ttl, cacheScope: `trakt:${ctx.scope}:${await fingerprint(s.token)}` });
  if (ctx.env.DB && result === null) throw new Error('trakt read unavailable');
  return result;
}

async function write(ctx: Ctx, s: Session, method: 'POST' | 'DELETE', path: string, payload?: unknown): Promise<boolean> {
  const res = await sendRequest(`${API}${path}`, {
    method, headers: headers(ctx, s.token),
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return res.ok || (path.startsWith('/scrobble/') && res.status === 409);
}

function bundleOf(ids: TraktIds | undefined, tmdbType?: 'movie' | 'tv'): IdBundle {
  const out: IdBundle = {};
  if (ids?.imdb) out.imdb = ids.imdb;
  if (ids?.tmdb) { out.tmdb = ids.tmdb; if (tmdbType) out.tmdbType = tmdbType; }
  if (ids?.tvdb) out.tvdb = ids.tvdb;
  return out;
}

function idsForWrite(ids: IdBundle): Record<string, string | number> | null {
  const out: Record<string, string | number> = {};
  if (ids.imdb) out.imdb = ids.imdb;
  if (ids.tmdb) out.tmdb = ids.tmdb;
  if (ids.tvdb) out.tvdb = ids.tvdb;
  return Object.keys(out).length ? out : null;
}

function posterOf(images: TraktImages | undefined): string | undefined {
  const p = images?.poster?.[0];
  return p ? (p.startsWith('http') ? p : `https://${p}`) : undefined;
}

function toPreview(entry: ListEntry, want: 'movie' | 'series'): MetaPreview | null {
  const item = want === 'movie' ? entry.movie : entry.show;
  if (!item) return null;
  const ids = bundleOf(item.ids, want === 'movie' ? 'movie' : 'tv');
  const id = stremioIdOf(ids);
  if (!id) return null;
  return {
    id,
    type: want,
    name: item.title ?? id,
    poster: posterOf(item.images),
    description: item.overview,
    genres: item.genres,
    year: item.year,
    releaseInfo: item.year ? String(item.year) : undefined,
  };
}

async function snapshot(ctx: Ctx): Promise<WatchSnapshot> {
  const s = await session(ctx);
  if (!s) return emptySnapshot();

  const [playback, movies, shows, dropped] = await Promise.all([
    get<PlaybackItem[]>(ctx, s, '/sync/playback', 30),
    allPages<WatchedMovieItem>(ctx, s, '/sync/watched/movies?extended=progress'),
    allPages<WatchedShowItem>(ctx, s, '/sync/watched/shows?extended=progress'),
    allPages<{ show?: TraktShow }>(ctx, s, '/users/hidden/dropped?type=show'),
  ]);

  const out = emptySnapshot();
  out.dropped = dropped.flatMap(row => row.show ? [bundleOf(row.show.ids, 'tv')] : []);

  for (const p of playback ?? []) {
    const progress = clampPercent(p.progress);
    if (progress <= 0) continue;
    const at = isoOrNow(p.paused_at);
    if (p.type === 'movie' && p.movie) {
      out.resume.push({ ids: bundleOf(p.movie.ids, 'movie'), kind: 'movie', progress, at, ref: p.id });
    } else if (p.type === 'episode' && p.show && p.episode) {
      out.resume.push({ ids: bundleOf(p.show.ids, 'tv'), kind: 'episode', season: p.episode.season, episode: p.episode.number, progress, at, ref: p.id });
    }
  }

  for (const m of movies ?? []) {
    if (!m.movie) continue;
    const row: WatchedMovie = { ids: bundleOf(m.movie.ids, 'movie'), plays: Number(m.plays) || 1, lastAt: isoOrNow(m.last_watched_at) };
    out.movies.push(row);
  }

  for (const w of shows ?? []) {
    if (!w.show) continue;
    const ids = bundleOf(w.show.ids, 'tv');
    let lastAt = isoOrNow(w.last_watched_at);
    let lastSeason: number | undefined;
    let lastEpisode: number | undefined;
    let best = 0;
    for (const season of w.seasons ?? []) {
      for (const ep of season.episodes ?? []) {
        const row: WatchedEpisode = { ids, season: season.number, episode: ep.number, plays: Number(ep.plays) || 1, lastAt: isoOrNow(ep.last_watched_at) };
        out.episodes.push(row);
        const t = epoch(ep.last_watched_at);
        if (t > best) { best = t; lastSeason = season.number; lastEpisode = ep.number; lastAt = row.lastAt; }
      }
    }
    out.shows.push({ ids, lastAt, lastSeason, lastEpisode });
  }
  out.shows.sort((a, b) => epoch(b.lastAt) - epoch(a.lastAt));
  out.resume.sort((a, b) => epoch(b.at) - epoch(a.at));
  out.fetchedAt = nowIso();
  return out;
}

async function allPages<T>(ctx: Ctx, s: Session, path: string): Promise<T[]> {
  const rows: T[] = [], seen = new Set<string>();
  for (let page = 1; page <= 1000; page++) {
    const data = await get<T[]>(ctx, s, `${path}${path.includes('?') ? '&' : '?'}page=${page}&limit=100`, 0);
    if (!Array.isArray(data)) throw new Error('Trakt list unavailable');
    if (!data.length) return rows;
    const signature = JSON.stringify(data);
    if (seen.has(signature)) throw new Error('Trakt repeated a list page');
    seen.add(signature); rows.push(...data);
  }
  throw new Error('Trakt list exceeds the import limit');
}

async function drop(ctx: Ctx, ev: DropEvent): Promise<void> {
  const s = await session(ctx), ids = idsForWrite(ev.ids);
  if (!s || !ids) throw new Error('Trakt show ID or credentials unavailable');
  const res = await sendRequest(`${API}/users/hidden/dropped${ev.dropped ? '' : '/remove'}`, {
    method: 'POST', headers: headers(ctx, s.token), body: JSON.stringify({ shows: [{ ids }] }),
  });
  if (!res.ok || (res.body as { not_found?: { shows?: unknown[] } } | null)?.not_found?.shows?.length) throw new Error('Trakt drop update rejected');
}

function scrobbleBody(ev: ScrobbleEvent, progress: number): unknown | null {
  const ids = idsForWrite(ev.ids);
  if (!ids) return null;
  const stamp = { progress, app_version: '1.0', app_date: new Date().toISOString().slice(0, 10) };
  if (ev.kind === 'movie') return { movie: { ids }, ...stamp };
  if (ev.season === undefined || ev.episode === undefined) return null;
  return { show: { ids }, episode: { season: ev.season, number: ev.episode }, ...stamp };
}

async function scrobble(ctx: Ctx, ev: ScrobbleEvent): Promise<void> {
  const s = await session(ctx);
  if (!s) return;
  const progress = clampPercent(ev.progress);
  if (ev.action !== 'start' && progress < MIN_SCROBBLE) return;
  const body = scrobbleBody(ev, progress);
  if (!body) return;
  if (!(await write(ctx, s, 'POST', `/scrobble/${ev.action}`, body))) throw new Error('Trakt scrobble rejected');
}

function historyBody(ev: MarkEvent): unknown | null {
  const ids = idsForWrite(ev.ids);
  if (!ids) return null;
  if (ev.kind === 'movie') return { movies: [{ ids }] };
  if (ev.kind === 'series') return { shows: [{ ids }] };
  if (ev.season === undefined || ev.episode === undefined) return null;
  return { shows: [{ ids, seasons: [{ number: ev.season, episodes: [{ number: ev.episode }] }] }] };
}

function sameTitle(entry: ResumeEntry, ev: MarkEvent): boolean {
  const a = stremioIdOf(entry.ids);
  const b = stremioIdOf(ev.ids);
  if (!a || a !== b) {
    const shared = (entry.ids.imdb && entry.ids.imdb === ev.ids.imdb) || (entry.ids.tmdb && entry.ids.tmdb === ev.ids.tmdb) || (entry.ids.tvdb && entry.ids.tvdb === ev.ids.tvdb);
    if (!shared) return false;
  }
  if (ev.kind === 'movie') return entry.kind === 'movie';
  if (ev.kind === 'series') return entry.kind === 'episode';
  return entry.kind === 'episode' && entry.season === ev.season && entry.episode === ev.episode;
}

async function mark(ctx: Ctx, ev: MarkEvent): Promise<void> {
  const s = await session(ctx);
  if (!s) return;
  const body = historyBody(ev);
  if (!body) return;
  if (!(await write(ctx, s, 'POST', ev.watched ? '/sync/history' : '/sync/history/remove', body))) throw new Error('Trakt history update rejected');
  if (!ev.watched) {
    const playback = await get<PlaybackItem[]>(ctx, s, '/sync/playback', 0);
    const snap = emptySnapshot();
    for (const p of playback ?? []) {
      if (p.type === 'movie' && p.movie) snap.resume.push({ ids: bundleOf(p.movie.ids), kind: 'movie', progress: p.progress, at: isoOrNow(p.paused_at), ref: p.id });
      else if (p.show && p.episode) snap.resume.push({ ids: bundleOf(p.show.ids), kind: 'episode', season: p.episode.season, episode: p.episode.number, progress: p.progress, at: isoOrNow(p.paused_at), ref: p.id });
    }
    for (const entry of snap.resume) {
      if (sameTitle(entry, ev) && entry.ref !== undefined) await write(ctx, s, 'DELETE', `/sync/playback/${entry.ref}`);
    }
  }
}

async function clearResume(ctx: Ctx, entry: ResumeEntry): Promise<void> {
  const s = await session(ctx);
  if (!s || entry.ref === undefined || entry.ref === null || entry.ref === '') return;
  await write(ctx, s, 'DELETE', `/sync/playback/${encodeURIComponent(String(entry.ref))}`);
}

const KINDS: Array<'movie' | 'series'> = ['movie', 'series'];

function traktType(kind: 'movie' | 'series'): 'movies' | 'shows' {
  return kind === 'movie' ? 'movies' : 'shows';
}

async function catalogs(ctx: Ctx): Promise<ManifestCatalog[]> {
  const s = await session(ctx);
  if (!s) return [];
  const out: ManifestCatalog[] = [];
  for (const kind of KINDS) {
    out.push({ type: kind, id: `trakt:watchlist:${kind}`, name: 'Trakt Watchlist', extra: [{ name: 'skip' }] });
    out.push({ type: kind, id: `trakt:recs:${kind}`, name: 'Trakt Recommendations', extra: [{ name: 'skip' }] });
    out.push({ type: kind, id: `trakt:favorites:${kind}`, name: 'Trakt Favorites', extra: [{ name: 'skip' }] });
  }
  const own = (await get<UserList[]>(ctx, s, '/users/me/lists', 600)) ?? [];
  for (const list of own) {
    if (!list?.ids?.trakt) continue;
    for (const kind of KINDS) out.push({ type: kind, id: `trakt:list:${kind}:me:${list.ids.trakt}`, name: `Trakt: ${list.name}`, extra: [{ name: 'skip' }] });
  }
  for (const raw of ctx.cfg.lists.trakt) {
    const ref = parseListRef(raw);
    if (!ref) continue;
    const label = ref.kind === 'numeric' ? `Trakt list ${ref.id}` : `Trakt: ${ref.slug}`;
    const suffix = ref.kind === 'numeric' ? String(ref.id) : `${ref.user}:${ref.slug}`;
    for (const kind of KINDS) out.push({ type: kind, id: `trakt:list:${kind}:${suffix}`, name: label, extra: [{ name: 'skip' }] });
  }
  return out;
}

type ListRef = { kind: 'numeric'; id: number } | { kind: 'user'; user: string; slug: string };

function parseListRef(raw: string): ListRef | null {
  const text = raw.trim().replace(/^https?:\/\/(www\.)?trakt\.tv\/users\//, '').replace(/\/lists\//, '/');
  if (/^\d+$/.test(text)) return { kind: 'numeric', id: Number(text) };
  const m = /^([^/:\s]+)[/:]([^/:\s]+)$/.exec(text);
  if (m) return { kind: 'user', user: m[1], slug: m[2] };
  return null;
}

function itemsPath(catalogId: string, page: number): { path: string; kind: 'movie' | 'series' } | null {
  const parts = catalogId.split(':');
  if (parts[0] !== 'trakt') return null;
  const q = `?page=${page}&limit=${PAGE}&extended=full,images`;
  if(parts[1]==='favorites'&&(parts[2]==='movie'||parts[2]==='series'))return{path:`/users/me/favorites/${traktType(parts[2])}/added${q}`,kind:parts[2]};
  if (parts[1] === 'watchlist' && (parts[2] === 'movie' || parts[2] === 'series')) {
    return { path: `/sync/watchlist/${traktType(parts[2])}/added${q}`, kind: parts[2] };
  }
  if (parts[1] === 'recs' && (parts[2] === 'movie' || parts[2] === 'series')) {
    return { path: `/recommendations/${traktType(parts[2])}?limit=${PAGE}&page=${page}&ignore_collected=true&ignore_watchlisted=false&extended=full,images`, kind: parts[2] };
  }
  if (parts[1] === 'list' && (parts[2] === 'movie' || parts[2] === 'series')) {
    const kind = parts[2];
    const t = traktType(kind);
    if (parts.length === 4 && /^\d+$/.test(parts[3])) return { path: `/lists/${parts[3]}/items/${t}${q}`, kind };
    if (parts.length === 5) return { path: `/users/${encodeURIComponent(parts[3])}/lists/${encodeURIComponent(parts[4])}/items/${t}${q}`, kind };
  }
  return null;
}

async function catalogItems(ctx: Ctx, catalogId: string, skip: number): Promise<MetaPreview[]> {
  const s = await session(ctx);
  if (!s) return [];
  const page = Math.floor(Math.max(0, skip) / PAGE) + 1;
  const target = itemsPath(catalogId, page);
  if (!target) return [];
  const rows = (await get<ListEntry[] | TraktMovie[]>(ctx, s, target.path, 300)) ?? [];
  const out: MetaPreview[] = [];
  for (const row of rows) {
    const entry: ListEntry = 'ids' in row ? (target.kind === 'movie' ? { movie: row as TraktMovie } : { show: row as TraktShow }) : (row as ListEntry);
    const preview = toPreview(entry, target.kind);
    if (preview) out.push(preview);
  }
  return out;
}

export const traktTracker: Tracker = {
  name: 'trakt',
  ready: (ctx) => !!auth(ctx),
  snapshot,
  scrobble,
  mark,
  clearResume,
  drop,
  catalogs,
  catalogItems,
};

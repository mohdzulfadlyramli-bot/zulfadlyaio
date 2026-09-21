import type { Ctx } from '../context';
import type { IdBundle } from '../meta/types';
import { fetchJson } from '../util/cache';
import { clampPercent, emptySnapshot, isoOrNow, sendRequest } from './common';
import type { MarkEvent, ResumeEntry, ScrobbleEvent, Tracker } from './types';

function url(ctx: Ctx, path: string): string {
  const u = new URL(`https://api.mdblist.com${path}`);
  u.searchParams.set('apikey', ctx.cfg.keys.mdblist ?? '');
  return u.href;
}
function idsOf(ids: IdBundle): IdBundle {
  const { imdb, tmdb, tvdb } = ids;
  if (!imdb && !tmdb && !tvdb) throw new Error('MDBList requires a movie or TV ID');
  return { imdb, tmdb, tvdb };
}
function item(ev: ScrobbleEvent | ResumeEntry) {
  const ids = idsOf(ev.ids);
  if (ev.kind === 'movie') return { movie: { ids } };
  if (ev.season === undefined || !ev.episode) throw new Error('MDBList requires episode numbering');
  return { show: { ids, season: { number: ev.season, episode: { number: ev.episode } } } };
}
async function write(ctx: Ctx, path: string, body: unknown): Promise<void> {
  const r = await sendRequest(url(ctx, path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok && !(path.startsWith('/scrobble/') && r.status === 409) && !(path === '/scrobble/clear' && r.status === 404)) throw new Error('MDBList write rejected');
}
interface Row {
  progress?: number; paused_at?: string; updated_at?: string; last_watched_at?: string;
  movie?: { ids: IdBundle }; show?: { ids: IdBundle };
  episode?: { season: number; number: number; show?: { ids: IdBundle } };
}
export const mdblistTracker: Tracker = {
  name: 'mdblist',
  ready: ctx => !!ctx.cfg.keys.mdblist,
  async drop(ctx, ev) {
    const r = await sendRequest(url(ctx, ev.dropped ? '/sync/dropped' : '/sync/dropped/remove'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shows: [{ ids: idsOf(ev.ids), ...(ev.dropped ? { dropped_at: new Date(ev.at).toISOString() } : {}) }] }),
    });
    const body = r.body as { not_found?: { shows?: unknown[] }; errors?: unknown[] } | null;
    if (!r.ok || body?.not_found?.shows?.length || body?.errors?.length) throw new Error('MDBList drop update rejected');
  },
  async scrobble(ctx, ev) {
    await write(ctx, `/scrobble/${ev.action}`, { ...item(ev), progress: clampPercent(ev.progress) });
  },
  async mark(ctx, ev: MarkEvent) {
    const ids = idsOf(ev.ids);
    if (ev.kind === 'series') throw new Error('Expand series into episodes before marking MDBList');
    if (ev.kind === 'episode' && (ev.season === undefined || !ev.episode)) throw new Error('MDBList requires episode numbering');
    const body = ev.kind === 'movie' ? { movies: [{ ids }] } : { shows: [{ ids, seasons: [{ number: ev.season, episodes: [{ number: ev.episode }] }] }] };
    await write(ctx, ev.watched ? '/sync/watched' : '/sync/watched/remove', body);
  },
  async clearResume(ctx, ev) { await write(ctx, '/scrobble/clear', item(ev)); },
  async snapshot(ctx) {
    const out = emptySnapshot();
    const read = async <T>(path: string): Promise<T> => {
      const value = await fetchJson<T>(url(ctx, path), { ttl: 30, cacheScope: ctx.scope });
      if (value === null) throw new Error('MDBList history unavailable');
      return value;
    };
    const history = async (kind: 'movie' | 'episode') => {
      const rows: Row[] = [];
      let cursor = '';
      const seen = new Set<string>();
      for (let page = 0; page < 100; page++) {
        const data = await read<{ movies?: Row[]; episodes?: Row[]; pagination?: { next_cursor?: string } }>(`/sync/watched?mediatype=${kind}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        rows.push(...(kind === 'movie' ? data.movies ?? [] : data.episodes ?? []));
        const next = data.pagination?.next_cursor;
        if (!next) return rows;
        if (seen.has(next) || next === cursor) throw new Error('MDBList repeated a history cursor');
        seen.add(next);
        cursor = next;
      }
      throw new Error('MDBList history exceeds the import limit; previous history was retained');
    };
    const dropped = async (): Promise<IdBundle[]> => {
      const rows: IdBundle[] = [], seen = new Set<string>();
      let cursor = '';
      for (let page = 0; page < 1000; page++) {
        const data = await read<{ shows: Array<{ ids?: IdBundle; show?: { ids: IdBundle }; dropped_at?: string | null }>; pagination?: { next_cursor?: string } }>(`/sync/dropped?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (!Array.isArray(data.shows)) throw new Error('MDBList dropped list unavailable');
        for (const row of data.shows) { const ids = row.show?.ids ?? row.ids; if (ids && row.dropped_at !== null) rows.push(ids); }
        const next = data.pagination?.next_cursor;
        if (!next) return rows;
        if (seen.has(next) || next === cursor) throw new Error('MDBList repeated a dropped cursor');
        seen.add(next); cursor = next;
      }
      throw new Error('MDBList dropped list exceeds the import limit');
    };
    const [movies, episodes, playback, droppedIds] = await Promise.all([history('movie'), history('episode'), read<Row[]>('/sync/playback'), dropped()]);
    out.dropped = droppedIds;
    for (const r of movies) if (r.movie) out.movies.push({ ids: r.movie.ids, plays: 1, lastAt: isoOrNow(r.last_watched_at) });
    for (const r of episodes) {
      const ids = r.episode?.show?.ids ?? r.show?.ids;
      if (!ids || !r.episode) continue;
      const lastAt = isoOrNow(r.last_watched_at);
      out.episodes.push({ ids, season: r.episode.season, episode: r.episode.number, plays: 1, lastAt });
      out.shows.push({ ids, lastAt, lastSeason: r.episode.season, lastEpisode: r.episode.number });
    }
    for (const r of playback) {
      const ids = r.movie?.ids ?? r.show?.ids ?? r.episode?.show?.ids;
      if (!ids || (!r.movie && !r.episode)) continue;
      out.resume.push({ ids, kind: r.movie ? 'movie' : 'episode', season: r.episode?.season, episode: r.episode?.number, progress: clampPercent(r.progress), at: isoOrNow(r.updated_at ?? r.paused_at) });
    }
    return out;
  },
};

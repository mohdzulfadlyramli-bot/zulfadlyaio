export type IdSource = 'imdb' | 'tmdb' | 'tvdb' | 'tvmaze' | 'tvdbc' | 'tmdbc' | 'kitsu' | 'mal' | 'anilist' | 'anidb' | 'other';

export interface ParsedId {
  source: IdSource;
  key: string;
  num?: number;
  season?: number;
  episode?: number;
  title: string;
  raw: string;
}

export function parseStremioId(raw: string): ParsedId {
  const s = String(raw || '').trim();
  const imdb = /^(tt\d+)(?::(\d+):(\d+))?$/.exec(s);
  if (imdb) {
    return { source: 'imdb', key: imdb[1], num: Number(imdb[1].slice(2)), season: imdb[2] ? Number(imdb[2]) : undefined, episode: imdb[3] ? Number(imdb[3]) : undefined, title: imdb[1], raw: s };
  }
  const pref = /^(tmdb|tvdb|tvmaze|tvdbc|tmdbc|kitsu|mal|anilist|anidb):(\d+)(?::(\d+))?(?::(\d+))?$/.exec(s);
  if (pref) {
    const source = pref[1] as IdSource;
    const num = Number(pref[2]);
    if (source === 'tmdb' || source === 'tvdb' || source==='tvmaze') {
      return { source, key: pref[2], num, season: pref[3] ? Number(pref[3]) : undefined, episode: pref[4] ? Number(pref[4]) : undefined, title: `${source}:${pref[2]}`, raw: s };
    }
    return { source, key: pref[2], num, season: pref[3] && pref[4] ? Number(pref[3]) : undefined, episode: pref[4] ? Number(pref[4]) : pref[3] ? Number(pref[3]) : undefined, title: `${source}:${pref[2]}`, raw: s };
  }
  const idx = s.indexOf(':');
  return { source: 'other', key: idx > 0 ? s.slice(0, idx) : s, title: idx > 0 ? s.slice(0, idx) : s, raw: s };
}

export function episodeId(titleId: string, season: number | undefined, episode: number): string {
  const p = parseStremioId(titleId);
  if (p.source === 'imdb' || p.source === 'tmdb' || p.source === 'tvdb' || p.source==='tvmaze') return `${p.title}:${season ?? 1}:${episode}`;
  return `${p.title}:${episode}`;
}

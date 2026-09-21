import type { Ctx } from '../context';
import type { Meta, MetaPerson } from '../stremio/types';
import type { IdBundle } from '../meta/types';
import { tmdbFind, tmdbMeta } from '../meta/tmdb';

function empty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length);
}

function mergePeople(existing: MetaPerson[], extra: MetaPerson[]): MetaPerson[] {
  const out = existing.map(person => ({ ...person }));
  for (const person of extra) {
    const found = out.find(p => p.type === person.type && (p.tmdbId && person.tmdbId ? p.tmdbId === person.tmdbId : p.name.toLowerCase() === person.name.toLowerCase()));
    if (!found) out.push(person);
    else {
      found.tmdbId ??= person.tmdbId;
      if (!found.role) found.role = person.role;
      if (!found.image) found.image = person.image;
    }
  }
  return out;
}

/** Enrich detail pages without changing add-on playback IDs or episode numbering. */
export async function enrichWithTmdb(ctx: Ctx, meta: Meta, seed: IdBundle, anime = false): Promise<Meta> {
  if (!ctx.tmdbKey || meta.collection) return meta;
  try {
    const kind = seed.tmdbType ?? (meta.type === 'movie' ? 'movie' : 'tv');
    const ids = await tmdbFind(ctx, { ...seed, ...meta.ids, tmdbType: kind });
    if (!ids.tmdb || ids.tmdbType !== kind) return meta;
    const extra = await tmdbMeta(ctx, kind, ids.tmdb, meta.id, { withEpisodes: false });
    if (!extra) return meta;
    const out: Meta = { ...meta };
    // Episode lists and behavior hints belong to the selected metadata add-on.
    for (const key of ['name', 'description', 'poster', 'background', 'logo', 'genres', 'releaseInfo', 'year', 'released', 'imdbRating', 'runtime', 'cast', 'director', 'writer', 'country', 'language', 'certification', 'status', 'network', 'trailers', 'originalTitle', 'tagline', 'studios'] as const) {
      if (empty(out[key]) && !empty(extra[key])) (out as unknown as Record<string, unknown>)[key] = extra[key];
    }
    out.ids = { ...extra.ids, ...meta.ids, tmdb: ids.tmdb };
    out.people = mergePeople(meta.people ?? [], extra.people ?? []);
    out.links = [...new Map([...(meta.links ?? []), ...(extra.links ?? [])].map(link => [`${link.category}:${link.url}`, link])).values()];
    // Only copy season artwork when the episode numbering is known to match TMDB.
    if (!anime && meta.videos?.every(v => v.numbering === 'tmdb')) out.seasonPosters = { ...extra.seasonPosters, ...meta.seasonPosters };
    return out;
  } catch {
    return meta;
  }
}

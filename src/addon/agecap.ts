import type { Ctx } from '../context';
import type { ContentType, MetaPreview } from '../stremio/types';
import { parseStremioId } from '../stremio/ids';
import { fetchJson } from '../util/cache';
import { mapLimit } from '../util/concurrency';
import { metaApi } from '../meta/index';
import { passesAgeCap, allowsUnrated } from '../meta/rating';

const TMDB = 'https://api.themoviedb.org/3';
const CERT_TTL = 7 * 24 * 3600;
const LOOKUP_CONCURRENCY = 5;

export function hasAgeCap(ctx: Ctx): boolean {
  const cap = (ctx.cfg.ageCap || '').trim().toLowerCase();
  return cap !== '' && cap !== 'none';
}

interface ReleaseDatesPayload { results?: Array<{ iso_3166_1: string; release_dates?: Array<{ certification?: string }> }> }
interface ContentRatingsPayload { results?: Array<{ iso_3166_1: string; rating?: string }> }

async function tmdbCertification(ctx: Ctx, type: ContentType, tmdbId: number): Promise<string | undefined> {
  if (!ctx.tmdbKey) return undefined;
  if (type === 'movie') {
    const data = await fetchJson<ReleaseDatesPayload>(`${TMDB}/movie/${tmdbId}/release_dates?api_key=${ctx.tmdbKey}`, { ttl: CERT_TTL });
    const us = data?.results?.find((r) => r.iso_3166_1 === 'US');
    return us?.release_dates?.map((d) => d.certification?.trim()).find((c) => c) || undefined;
  }
  const data = await fetchJson<ContentRatingsPayload>(`${TMDB}/tv/${tmdbId}/content_ratings?api_key=${ctx.tmdbKey}`, { ttl: CERT_TTL });
  const us = data?.results?.find((r) => r.iso_3166_1 === 'US');
  return us?.rating?.trim() || undefined;
}

async function certificationFor(ctx: Ctx, type: ContentType, item: MetaPreview): Promise<string | undefined> {
  const parsed = parseStremioId(item.id);
  if (parsed.source === 'tmdb' && parsed.num) {
    return tmdbCertification(ctx, type === 'movie' ? 'movie' : 'series', parsed.num);
  }
  try {
    const meta = await metaApi.resolveMeta(ctx, type, item.id);
    return meta?.certification || undefined;
  } catch {
    return undefined;
  }
}

export async function applyAgeCap(ctx: Ctx, type: ContentType, items: MetaPreview[]): Promise<MetaPreview[]> {
  if (!hasAgeCap(ctx) || items.length === 0) return items;
  const cap = ctx.cfg.ageCap.trim();
  if (type === 'anime') return items;
  const unratedOk = allowsUnrated(cap);
  const verdicts = await mapLimit(items, LOOKUP_CONCURRENCY, async (item) => {
    const cert = await certificationFor(ctx, type, item);
    if (!cert) return unratedOk;
    return passesAgeCap(cert, cap);
  });
  return items.filter((_, i) => verdicts[i]);
}

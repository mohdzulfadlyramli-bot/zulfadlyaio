import type { Meta } from '../stremio/types';
import { decodeGuid } from './ids';
import type { Library } from './library';
import { personFor } from './people';
import { boxSetCoverUrl, boxSetOf, collectionOf } from './collections';

export type ImageKind = 'primary' | 'backdrop' | 'logo' | 'thumb' | 'banner' | 'art';

function pickTitleImage(meta: Meta, kind: ImageKind): string | undefined {
  switch (kind) {
    case 'primary':
      return meta.poster || meta.background;
    case 'backdrop':
    case 'thumb':
    case 'art':
    case 'banner':
      return meta.background || meta.poster;
    case 'logo':
      return meta.logo;
    default:
      return undefined;
  }
}

export async function imageUrlFor(lib: Library, itemId: string, kindRaw: string): Promise<string | null> {
  const kind = kindRaw.toLowerCase() as ImageKind;
  const g = decodeGuid(itemId);
  if (!g || g.kind === 'view') return null;
  if(g.kind==='misc') {
    if (g.sub === 'collection') {
      const collection = (await collectionOf(lib, g))?.collection;
      if (!collection) return null;
      if (kind === 'primary') return collection.cover ?? collection.backdrop ?? null;
      if (kind === 'logo') return null;
      return collection.backdrop ?? collection.cover ?? null;
    }
    if (g.sub === 'boxset') {
      const found = await boxSetOf(lib, g);
      return found ? boxSetCoverUrl(lib, found.folder, kind) : null;
    }
    const person=await personFor(lib.ctx,g);
    return person?.profile_path?`https://image.tmdb.org/t/p/h632${person.profile_path}`:null;
  }

  if (g.kind === 'movie' || g.kind === 'series') {
    const meta = await lib.meta(g);
    return meta ? pickTitleImage(meta, kind) ?? null : null;
  }

  const show = await lib.show(g);
  if (!show) return null;
  if (g.kind === 'season') {
    if(kind==='primary'&&g.season!==undefined&&show.meta.seasonPosters?.[g.season])return show.meta.seasonPosters[g.season];
    return pickTitleImage(show.meta, kind === 'primary' ? 'primary' : kind) ?? null;
  }
  const ep = lib.findEpisode(show, g);
  if (kind === 'primary') return ep?.video.thumbnail || show.meta.background || show.meta.poster || null;
  return pickTitleImage(show.meta, kind) ?? null;
}

export function redirectTo(url: string): Response {
  return new Response(null, { status: 302, headers: { location: url, 'cache-control': 'public, max-age=86400' } });
}

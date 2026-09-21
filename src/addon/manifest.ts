import { BRAND_NAME, BRAND_VERSION } from '../brand';
import type { Ctx } from '../context';
import type { Manifest, ManifestCatalog } from '../stremio/types';
import { enabledCatalogDefinitions, type CatalogDefinition } from './catalogs';

export const ADDON_ID = 'community.rill';
export const ADDON_VERSION = '0.1.0';

export const ID_PREFIXES = ['tt', 'tmdb:', 'tvdb:', 'tvmaze:', 'tvdbc:', 'tmdbc:', 'kitsu:', 'mal:', 'anilist:', 'anidb:'];

export function catalogToManifestEntry(def: CatalogDefinition): ManifestCatalog {
  const entry: ManifestCatalog = { type: def.type, id: def.id, name: def.name };
  if (def.extra?.length) {
    entry.extra = def.extra;
    entry.extraSupported = def.extra.map((e) => e.name);
    const required = def.extra.filter((e) => e.isRequired).map((e) => e.name);
    if (required.length) entry.extraRequired = required;
  }
  if (def.genres?.length) entry.genres = def.genres;
  return entry;
}

export async function buildManifest(ctx: Ctx): Promise<Manifest> {
  const defs = await enabledCatalogDefinitions(ctx);
  const catalogs = defs.map(catalogToManifestEntry);
  const types = Array.from(new Set<string>(['movie', 'series', 'anime', ...catalogs.map((c) => c.type)]));
  const name = ctx.cfg.name?.trim() || BRAND_NAME;
  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name,
    description: `${name}: software you deploy and manage in your own Cloudflare account.`,
    logo: `${ctx.origin}/logo.svg?v=${BRAND_VERSION}`,
    resources: [
      'catalog',
      { name: 'meta', types: ['movie', 'series', 'anime'], idPrefixes: ID_PREFIXES },
      { name: 'stream', types: ['movie', 'series', 'anime'], idPrefixes: ID_PREFIXES },
      { name: 'subtitles', types: ['movie', 'series', 'anime'], idPrefixes: ID_PREFIXES },
    ],
    types,
    idPrefixes: ID_PREFIXES,
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: false, adult: ctx.cfg.search.includeAdult === true },
  };
}

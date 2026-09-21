import type { CollectionFolder, CollectionGenerator, CollectionSource, JellyfinCollection, TileShape } from '../config/schema';
import type { Meta, MetaPreview } from '../stremio/types';
import { applyAgeCap } from '../addon/agecap';
import { collectionMembers, collectionMeta } from '../addon/collections';
import { discoverItems } from '../addon/discovery';
import { tmdbGet } from '../meta/tmdb';
import { collectionFolder, imageTag, userData, type Dto } from './dto';
import { boxSetIdOf, collectionIdOf, fnv1a32, type LabelGuid } from './ids';
import type { CatalogRef, Library } from './library';
import { creditsFor } from './people';
import { DECADES, FRANCHISES, NETWORKS, STUDIOS, dedupe } from './curated';

const SHAPE_RATIO: Record<TileShape, number> = { poster: 0.6666666666666666, landscape: 1.7777777777777777, square: 1 };
const GENERATOR_SHAPE: Record<CollectionGenerator['kind'], TileShape> = { genres: 'landscape', decades: 'landscape', people: 'poster', studios: 'square', networks: 'square', franchises: 'poster' };
const TMDB_IMG = 'https://image.tmdb.org/t/p/';

export interface VisibleFolder {
  folder: CollectionFolder;
  id: string;
  shape: TileShape;
  sources: Array<{ source: CollectionSource; catalog: CatalogRef | null }>;
}

export interface VisibleCollection {
  collection: JellyfinCollection;
  id: string;
  folders: VisibleFolder[];
}

function slug(text: string): string {
  return fnv1a32(text).toString(16);
}

function catalogFor(catalogs: CatalogRef[], id: string, type: string): CatalogRef | null {
  return catalogs.find((c) => c.id === id && c.type === type && c.browsable) ?? null;
}

function sourceAvailable(L: Library, catalogs: CatalogRef[], source: CollectionSource): { source: CollectionSource; catalog: CatalogRef | null } | null {
  if (source.kind === 'catalog') {
    const catalog = catalogFor(catalogs, source.id, source.type);
    return catalog ? { source, catalog } : null;
  }
  return L.ctx.tmdbKey ? { source, catalog: null } : null;
}

async function expand(L: Library, catalogs: CatalogRef[], g: CollectionGenerator): Promise<CollectionFolder[]> {
  const limit = g.limit ?? 24;
  const type = g.type ?? 'movie';
  const out: CollectionFolder[] = [];
  const push = (key: string, name: string, source: CollectionSource, cover?: string) => {
    if (out.length < limit) out.push({ id: `${g.id}-${slug(key)}`, name, shape: g.shape, cover, sources: [source] });
  };
  if (g.kind === 'genres') {
    if (g.catalog) {
      const catalog = catalogFor(catalogs, g.catalog.id, g.catalog.type);
      for (const genre of catalog?.genres ?? []) push(genre, genre, { kind: 'catalog', id: g.catalog.id, type: g.catalog.type, genre });
    } else if (L.ctx.tmdbKey) {
      const data = await tmdbGet<{ genres?: Array<{ id: number; name: string }> }>(L.ctx, `/genre/${type === 'movie' ? 'movie' : 'tv'}/list`, { language: L.ctx.cfg.language }, 7 * 86400);
      for (const genre of data?.genres ?? []) push(String(genre.id), genre.name, { kind: 'discover', type, params: { with_genres: String(genre.id), sort_by: 'popularity.desc', 'vote_count.gte': '100' } });
    }
  } else if (g.kind === 'decades') {
    const field = type === 'movie' ? 'primary_release_date' : 'first_air_date';
    for (const d of DECADES) push(d.name, d.name, { kind: 'discover', type, params: { [`${field}.gte`]: d.from, [`${field}.lte`]: d.to, sort_by: 'vote_average.desc', 'vote_count.gte': '300' } });
  } else if (g.kind === 'people') {
    if (g.ids?.length) {
      for (const id of g.ids) {
        const p = await tmdbGet<{ id: number; name: string; profile_path?: string }>(L.ctx, `/person/${id}`, { language: L.ctx.cfg.language }, 7 * 86400);
        if (p) push(String(id), p.name, { kind: 'person', id, name: p.name }, p.profile_path ? `${TMDB_IMG}h632${p.profile_path}` : undefined);
      }
    } else {
      for (let page = 1; out.length < limit && page <= 5; page++) {
        const data = await tmdbGet<{ results?: Array<{ id: number; name: string; profile_path?: string; known_for_department?: string; adult?: boolean }> }>(L.ctx, '/person/popular', { language: L.ctx.cfg.language, page }, 86400);
        if (!data?.results?.length) break;
        for (const p of data.results) if (!p.adult && p.known_for_department === 'Acting') push(String(p.id), p.name, { kind: 'person', id: p.id, name: p.name }, p.profile_path ? `${TMDB_IMG}h632${p.profile_path}` : undefined);
      }
    }
  } else if (g.kind === 'studios') {
    const list = g.ids?.length ? g.ids.map((id) => STUDIOS.find((s) => s.id === id) ?? { id, name: `Studio ${id}` }) : dedupe(STUDIOS);
    for (const s of list) push(String(s.id), s.name, { kind: 'studio', id: s.id, name: s.name, type });
  } else if (g.kind === 'networks') {
    const list = g.ids?.length ? g.ids.map((id) => NETWORKS.find((s) => s.id === id) ?? { id, name: `Network ${id}` }) : dedupe(NETWORKS);
    for (const s of list) push(String(s.id), s.name, { kind: 'network', id: s.id, name: s.name });
  } else if (g.kind === 'franchises') {
    const configured = (L.ctx.cfg.lists.tmdbCollections ?? []).map((raw) => Number(String(raw).match(/(\d+)/)?.[1])).filter((n) => Number.isInteger(n) && n > 0);
    const ids = g.ids?.length ? g.ids : configured.length ? configured : dedupe(FRANCHISES).map((f) => f.id);
    for (const id of ids) {
      const known = FRANCHISES.find((f) => f.id === id);
      push(String(id), known?.name ?? `Collection ${id}`, { kind: 'franchise', id, name: known?.name ?? '' });
    }
  }
  return out;
}

export async function visibleCollections(L: Library): Promise<VisibleCollection[]> {
  const cache = L as unknown as { collectionsPromise?: Promise<VisibleCollection[]> };
  if (cache.collectionsPromise) return cache.collectionsPromise;
  cache.collectionsPromise = (async () => {
    const all = L.ctx.cfg.jellyfin.collections ?? [];
    if (!all.length) return [];
    const catalogs = await L.catalogs();
    const profile = L.ctx.profile?.id;
    const out: VisibleCollection[] = [];
    for (const collection of all) {
      if (collection.profiles?.length && (!profile || !collection.profiles.includes(profile))) continue;
      const folders: VisibleFolder[] = [];
      const add = (folder: CollectionFolder) => {
        const sources = folder.sources.map((s) => sourceAvailable(L, catalogs, s)).filter((x): x is NonNullable<typeof x> => !!x);
        if (sources.length) folders.push({ folder, id: boxSetIdOf(collection.id, folder.id), shape: folder.shape ?? collection.shape ?? 'poster', sources });
      };
      for (const g of collection.generators ?? []) {
        try {
          for (const folder of await expand(L, catalogs, g)) add({ ...folder, shape: folder.shape ?? g.shape ?? GENERATOR_SHAPE[g.kind] });
        } catch {
          continue;
        }
      }
      for (const folder of collection.folders) add(folder);
      if (folders.length) out.push({ collection, id: collectionIdOf(collection.id), folders });
    }
    return out;
  })();
  return cache.collectionsPromise;
}

export async function collectionOf(L: Library, g: LabelGuid): Promise<VisibleCollection | null> {
  if (g.kind !== 'misc' || g.sub !== 'collection') return null;
  return (await visibleCollections(L)).find((c) => fnv1a32(c.collection.id) === g.hash) ?? null;
}

export async function boxSetOf(L: Library, g: LabelGuid): Promise<{ collection: VisibleCollection; folder: VisibleFolder } | null> {
  if (g.kind !== 'misc' || g.sub !== 'boxset') return null;
  for (const collection of await visibleCollections(L)) {
    for (const folder of collection.folders) {
      if (fnv1a32(`${collection.collection.id}|${folder.folder.id}`) === g.hash) return { collection, folder };
    }
  }
  return null;
}

export function collectionViewDto(L: Library, c: VisibleCollection): Dto {
  const view = collectionFolder(c.id, L.jf.who, c.collection.name, 'boxsets');
  view.ChildCount = c.folders.length;
  view.Overview = c.collection.description ?? null;
  const cover = imageTag(c.collection.cover);
  const backdrop = imageTag(c.collection.backdrop);
  if (cover || backdrop) {
    view.ImageTags = { Primary: cover ?? backdrop! };
    view.PrimaryImageAspectRatio = SHAPE_RATIO[c.collection.coverShape ?? (cover ? 'poster' : 'landscape')];
  }
  if (backdrop) view.BackdropImageTags = [backdrop];
  return view;
}

export function boxSetDto(L: Library, c: VisibleCollection, f: VisibleFolder): Dto {
  const cover = imageTag(f.folder.cover);
  const backdrop = imageTag(f.folder.backdrop);
  const logo = imageTag(f.folder.logo);
  const imageTags: Record<string, string> = { Primary: cover ?? f.id };
  if (logo) imageTags.Logo = logo;
  imageTags.Thumb = backdrop ?? f.id;
  return {
    Name: f.folder.name,
    OriginalTitle: f.folder.name,
    SortName: f.folder.name.toLowerCase(),
    ServerId: L.jf.who.serverId,
    Id: f.id,
    Etag: f.id,
    DateCreated: new Date(0).toISOString(),
    CanDelete: false,
    CanDownload: false,
    ExternalUrls: [],
    Path: `/library/${c.id}/${f.id}`,
    EnableMediaSourceDisplay: false,
    Taglines: [],
    RemoteTrailers: [],
    ProviderIds: {},
    IsFolder: true,
    ParentId: c.id,
    Type: 'BoxSet',
    People: [],
    Studios: [],
    Genres: [],
    GenreItems: [],
    LocalTrailerCount: 0,
    UserData: userData(f.id),
    ChildCount: null,
    RecursiveItemCount: null,
    DisplayPreferencesId: f.id,
    Tags: [],
    PrimaryImageAspectRatio: SHAPE_RATIO[f.shape],
    ImageTags: imageTags,
    BackdropImageTags: [backdrop ?? f.id],
    ImageBlurHashes: {},
    LocationType: 'FileSystem',
    MediaType: 'Unknown',
    LockedFields: [],
    LockData: false,
  };
}

interface SourcePage { items: MetaPreview[]; hasMore: boolean }

async function capped(L: Library, previews: MetaPreview[]): Promise<MetaPreview[]> {
  const movies = await applyAgeCap(L.ctx, 'movie', previews.filter((m) => m.type === 'movie'));
  const series = await applyAgeCap(L.ctx, 'series', previews.filter((m) => m.type !== 'movie'));
  const keep = new Set([...movies, ...series].map((m) => m.id));
  return previews.filter((m) => keep.has(m.id));
}

function discoverSource(source: CollectionSource): { type: 'movie' | 'series'; params: Record<string, string> } | null {
  if (source.kind === 'discover') return { type: source.type, params: source.params };
  if (source.kind === 'studio') return { type: source.type, params: { with_companies: String(source.id), sort_by: 'popularity.desc' } };
  if (source.kind === 'network') return { type: 'series', params: { with_networks: String(source.id), sort_by: 'popularity.desc' } };
  return null;
}

async function readSource(L: Library, entry: VisibleFolder['sources'][number], from: number, need: number): Promise<SourcePage> {
  const { source, catalog } = entry;
  try {
    if (source.kind === 'catalog') return catalog ? await L.window(catalog, from, need, source.genre ? { genre: source.genre } : {}) : { items: [], hasMore: false };
    if (source.kind === 'person') {
      if (from > 0) return { items: [], hasMore: false };
      return { items: await capped(L, await creditsFor(L.ctx, source.id)), hasMore: false };
    }
    if (source.kind === 'franchise') {
      const page = await collectionMembers(L.ctx, `tmdbc:${source.id}`, from, Math.max(need, 20));
      return { items: await capped(L, page.items), hasMore: from + page.items.length < page.total };
    }
    const d = discoverSource(source);
    if (!d) return { items: [], hasMore: false };
    const items = await discoverItems(L.ctx, { id: 'collection', name: '', type: d.type, provider: 'tmdb', params: d.params }, { skip: from });
    return { items: await capped(L, items.map((m) => ({ ...m, type: m.type ?? d.type }))), hasMore: items.length >= 20 };
  } catch {
    return { items: [], hasMore: false };
  }
}

function itemOf(L: Library, m: MetaPreview, entry: VisibleFolder['sources'][number], parentId: string): Dto | null {
  if (entry.catalog) return L.previewItem(m, entry.catalog, parentId);
  const kind = m.type === 'movie' ? 'movie' : 'series';
  const fake: CatalogRef = { id: 'collection', type: kind, name: '', group: '', genres: [], searchable: false, browsable: false, viewId: '', hash: 0 };
  return L.previewItem(m, fake, parentId);
}

export async function boxSetMembers(L: Library, f: VisibleFolder, start: number, limit: number): Promise<{ items: Dto[]; hasMore: boolean }> {
  const seen = new Set<string>();
  const collected: Dto[] = [];
  let offset = 0;
  let more = false;
  outer: for (const entry of f.sources) {
    let from = 0;
    for (;;) {
      if (collected.length >= limit) {
        more = true;
        break outer;
      }
      const need = limit - collected.length + Math.max(0, start - offset);
      const page = await readSource(L, entry, from, need);
      for (const m of page.items) {
        const id = String(m?.id ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if (offset >= start && collected.length < limit) {
          const item = itemOf(L, m, entry, f.id);
          if (!item) continue;
          collected.push(item);
        }
        offset++;
      }
      if (!page.hasMore || page.items.length === 0) break;
      from += page.items.length;
    }
  }
  return { items: await L.decorate(collected), hasMore: more };
}

async function brandLogo(L: Library, source: CollectionSource): Promise<string | null> {
  if (source.kind !== 'studio' && source.kind !== 'network') return null;
  const data = await tmdbGet<{ logo_path?: string }>(L.ctx, `/${source.kind === 'studio' ? 'company' : 'network'}/${source.id}`, {}, 7 * 86400);
  return data?.logo_path ? `${TMDB_IMG}w500${data.logo_path}` : null;
}

export async function boxSetCoverUrl(L: Library, f: VisibleFolder, kind: string): Promise<string | null> {
  const wantsWide = kind !== 'primary' && kind !== 'logo';
  if (kind === 'logo') {
    if (f.folder.logo) return f.folder.logo;
    for (const s of f.sources) {
      const logo = await brandLogo(L, s.source);
      if (logo) return logo;
    }
    return null;
  }
  if (!wantsWide && f.folder.cover) return f.folder.cover;
  if (wantsWide && f.folder.backdrop) return f.folder.backdrop;
  for (const s of f.sources) {
    if (s.source.kind === 'person' && !wantsWide) {
      const data = await tmdbGet<{ profile_path?: string }>(L.ctx, `/person/${s.source.id}`, { language: L.ctx.cfg.language }, 7 * 86400);
      if (data?.profile_path) return `${TMDB_IMG}h632${data.profile_path}`;
    }
    if (s.source.kind === 'franchise') {
      const meta = await collectionMeta(L.ctx, `tmdbc:${s.source.id}`).catch(() => null);
      const pick = wantsWide ? meta?.background ?? meta?.poster : meta?.poster ?? meta?.background;
      if (pick) return pick;
    }
    if (!wantsWide && f.shape !== 'poster') {
      const logo = await brandLogo(L, s.source);
      if (logo) return logo;
    }
  }
  const first = await boxSetMembers(L, f, 0, 1);
  const tags = (first.items[0]?.ImageTags ?? {}) as Record<string, string>;
  const pick = wantsWide || f.shape === 'landscape' ? tags.Thumb ?? tags.Primary : tags.Primary ?? tags.Thumb;
  return imageTag(pick) ?? (wantsWide ? f.folder.cover ?? null : null);
}

export function exportCollection(c: JellyfinCollection): Record<string, unknown> {
  return { rill: 'collection', v: 1, collection: c };
}

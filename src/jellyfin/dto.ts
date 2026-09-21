import type { Ctx } from '../context';
import type { Meta, MetaPreview, MetaVideo, Stream, Subtitle } from '../stremio/types';
import { sha256 } from '../util/bytes';
import type { ClientInfo, Identity } from './auth';
import { genreIdOf, personIdOf, type TitleGuid } from './ids';

export const TICKS_PER_MS = 10_000;
export const SERVER_VERSION = '10.10.7';
export const PRODUCT_NAME = 'Jellyfin Server';

export type Dto = Record<string, unknown>;

export function serverName(ctx: Ctx): string {
  return ctx.cfg.name?.trim() || 'Rill';
}

export function runtimeTicks(runtime: unknown): number | null {
  if (runtime === undefined || runtime === null) return null;
  const text = String(runtime).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 60_000 * TICKS_PER_MS;
  const h = /(\d+)\s*h/i.exec(text);
  const m = /(\d+)\s*m/i.exec(text);
  const minutes = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
  return minutes > 0 ? minutes * 60_000 * TICKS_PER_MS : null;
}

export function ticksToMs(ticks: unknown): number | null {
  const n = typeof ticks === 'number' ? ticks : parseInt(String(ticks ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? Math.round(n / TICKS_PER_MS) : null;
}

export function publicSystemInfo(ctx: Ctx, who: Identity, base: string): Dto {
  return {
    LocalAddress: base,
    ServerName: serverName(ctx),
    Version: SERVER_VERSION,
    ProductName: PRODUCT_NAME,
    OperatingSystem: 'Linux',
    Id: who.serverId,
    StartupWizardCompleted: true,
  };
}

export function systemInfo(ctx: Ctx, who: Identity, base: string): Dto {
  return {
    ...publicSystemInfo(ctx, who, base),
    OperatingSystemDisplayName: 'Linux',
    PackageName: 'rill',
    HasPendingRestart: false,
    IsShuttingDown: false,
    SupportsLibraryMonitor: false,
    WebSocketPortNumber: 443,
    CompletedInstallations: [],
    CanSelfRestart: false,
    CanLaunchWebBrowser: false,
    ProgramDataPath: '/config',
    WebPath: '/web',
    ItemsByNamePath: '/config/metadata',
    CachePath: '/cache',
    LogPath: '/config/log',
    InternalMetadataPath: '/config/metadata',
    TranscodingTempPath: '/cache/transcodes',
    HasUpdateAvailable: false,
    EncoderLocation: 'NotFound',
    SystemArchitecture: 'X64',
  };
}

export function userDto(ctx: Ctx, who: Identity): Dto {
  const now = new Date().toISOString();
  return {
    Name: ctx.profile?.name || ctx.cfg.jellyfin.username || 'Rill',
    ServerId: who.serverId,
    Id: who.userId,
    PrimaryImageTag: ctx.profile?.avatar ? encodeURIComponent(ctx.profile.avatar) : undefined,
    HasPassword: Boolean(ctx.cfg.jellyfin.password),
    HasConfiguredPassword: Boolean(ctx.cfg.jellyfin.password),
    HasConfiguredEasyPassword: false,
    EnableAutoLogin: false,
    LastLoginDate: now,
    LastActivityDate: now,
    Configuration: {
      PlayDefaultAudioTrack: true,
      SubtitleLanguagePreference: '',
      DisplayMissingEpisodes: false,
      GroupedFolders: [],
      SubtitleMode: 'Default',
      DisplayCollectionsView: false,
      EnableLocalPassword: false,
      OrderedViews: [],
      LatestItemsExcludes: [],
      MyMediaExcludes: [],
      HidePlayedInLatest: true,
      RememberAudioSelections: true,
      RememberSubtitleSelections: true,
      EnableNextEpisodeAutoPlay: true,
      CastReceiverId: '',
    },
    Policy: {
      IsAdministrator: false,
      IsHidden: true,
      IsDisabled: false,
      EnableCollectionManagement: false,
      EnableSubtitleManagement: false,
      EnableLyricManagement: false,
      BlockedTags: [],
      AllowedTags: [],
      EnableUserPreferenceAccess: true,
      AccessSchedules: [],
      BlockUnratedItems: [],
      EnableRemoteControlOfOtherUsers: false,
      EnableSharedDeviceControl: false,
      EnableRemoteAccess: true,
      EnableLiveTvManagement: false,
      EnableLiveTvAccess: false,
      EnableMediaPlayback: true,
      EnableAudioPlaybackTranscoding: false,
      EnableVideoPlaybackTranscoding: false,
      EnablePlaybackRemuxing: false,
      ForceRemoteSourceTranscoding: false,
      EnableContentDeletion: false,
      EnableContentDeletionFromFolders: [],
      EnableContentDownloading: false,
      EnableSyncTranscoding: false,
      EnableMediaConversion: false,
      EnabledDevices: [],
      EnableAllDevices: true,
      EnabledChannels: [],
      EnableAllChannels: true,
      EnabledFolders: [],
      EnableAllFolders: true,
      InvalidLoginAttemptCount: 0,
      LoginAttemptsBeforeLockout: -1,
      MaxActiveSessions: 0,
      EnablePublicSharing: false,
      BlockedMediaFolders: [],
      BlockedChannels: [],
      RemoteClientBitrateLimit: 0,
      AuthenticationProviderId: 'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider',
      PasswordResetProviderId: 'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider',
      SyncPlayAccess: 'None',
    },
  };
}

export function sessionDto(ctx: Ctx, who: Identity, client: ClientInfo): Dto {
  const now = new Date().toISOString();
  return {
    Id: `${who.userId}-${client.deviceId}`,
    UserId: who.userId,
    UserName: ctx.profile?.name || ctx.cfg.jellyfin.username || 'Rill',
    ServerId: who.serverId,
    Client: client.client,
    DeviceName: client.device,
    DeviceId: client.deviceId,
    ApplicationVersion: client.version,
    IsActive: true,
    SupportsMediaControl: false,
    SupportsRemoteControl: false,
    HasCustomDeviceName: false,
    PlayableMediaTypes: ['Video'],
    SupportedCommands: [],
    NowPlayingQueue: [],
    NowPlayingQueueFullItems: [],
    AdditionalUsers: [],
    LastActivityDate: now,
    LastPlaybackCheckIn: now,
  };
}

export function listOf(items: unknown[], total: number, startIndex: number): Dto {
  return { Items: items, TotalRecordCount: total, StartIndex: startIndex };
}

export interface UserDataInput {
  played?: boolean;
  playCount?: number;
  positionTicks?: number;
  runtimeTicks?: number | null;
  lastPlayed?: string;
  unplayed?: number;
}

export function userData(id: string, u: UserDataInput = {}): Dto {
  const position = Math.max(0, Math.round(u.positionTicks ?? 0));
  const runtime = u.runtimeTicks ?? 0;
  const percent = position > 0 && runtime > 0 ? Math.min(100, (position / runtime) * 100) : u.played ? 100 : 0;
  const out: Dto = {
    PlaybackPositionTicks: position,
    PlayCount: u.playCount ?? (u.played ? 1 : 0),
    IsFavorite: false,
    Played: Boolean(u.played),
    PlayedPercentage: percent,
    Key: id,
    ItemId: id,
  };
  if (u.unplayed !== undefined) out.UnplayedItemCount = u.unplayed;
  if (u.lastPlayed) out.LastPlayedDate = u.lastPlayed;
  return out;
}

export function collectionFolder(id: string, who: Identity, name: string, collectionType: string | null): Dto {
  return {
    Name: name,
    ServerId: who.serverId,
    Id: id,
    Etag: id,
    DateCreated: new Date(0).toISOString(),
    CanDelete: false,
    CanDownload: false,
    SortName: name.toLowerCase(),
    ExternalUrls: [],
    Path: `/library/${id}`,
    EnableMediaSourceDisplay: false,
    Taglines: [],
    RemoteTrailers: [],
    ProviderIds: {},
    IsFolder: true,
    ParentId: null,
    Type: 'CollectionFolder',
    People: [],
    Studios: [],
    GenreItems: [],
    LocalTrailerCount: 0,
    UserData: userData(id),
    ChildCount: null,
    DisplayPreferencesId: id,
    Tags: [],
    PrimaryImageAspectRatio: 1,
    CollectionType: collectionType,
    ImageTags: {},
    BackdropImageTags: [],
    ImageBlurHashes: {},
    LocationType: 'FileSystem',
    MediaType: 'Unknown',
    LockedFields: [],
    LockData: false,
  };
}

function yearOf(m: MetaPreview): number | null {
  const y = parseInt(String(m.year ?? m.releaseInfo ?? '').slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

function premiereOf(m: MetaPreview & { released?: string }): string | null {
  if (typeof m.released === 'string' && m.released) return m.released;
  const y = yearOf(m);
  return y ? new Date(Date.UTC(y, 0, 1)).toISOString() : null;
}

function ratingOf(v: unknown): number | null {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : null;
}

export function providerIds(meta: Partial<Meta>, g: TitleGuid): Record<string, string> {
  const out: Record<string, string> = {};
  const ids = meta.ids ?? {};
  const own = g.source;
  if (g.anime && own !== 'imdb' && own !== 'tmdb' && own !== 'tvdb') {
    if (ids.mal) out.MyAnimeList = String(ids.mal);
    if (ids.anilist) out.AniList = String(ids.anilist);
    if (ids.kitsu) out.Kitsu = String(ids.kitsu);
    if (ids.anidb) out.AniDB = String(ids.anidb);
    if (!Object.keys(out).length) out[own === 'mal' ? 'MyAnimeList' : own === 'anilist' ? 'AniList' : own === 'kitsu' ? 'Kitsu' : 'AniDB'] = String(g.num);
    return out;
  }
  if (ids.imdb) out.Imdb = ids.imdb;
  if (ids.tmdb) out.Tmdb = String(ids.tmdb);
  if (ids.tvdb) out.Tvdb = String(ids.tvdb);
  if (!Object.keys(out).length) {
    if (own === 'imdb') out.Imdb = `tt${String(g.num).padStart(7, '0')}`;
    else if (own === 'tmdb') out.Tmdb = String(g.num);
    else if (own === 'tvdb') out.Tvdb = String(g.num);
  }
  return out;
}

function peopleOf(meta: Partial<Meta>): Dto[] {
  const out: Dto[] = (meta.people ?? []).map(p => ({ Name: p.name, Id: personIdOf(p.name, p.tmdbId), Role: p.role ?? '', Type: p.type, PrimaryImageTag: imageTag(p.image) }));
  for (const [type, names] of [['Actor', (meta.cast ?? []).slice(0, 20)], ['Director', meta.director ?? []], ['Writer', meta.writer ?? []]] as const) {
    for (const name of names) if (!out.some(p => p.Type === type && String(p.Name).toLowerCase() === name.toLowerCase())) out.push({ Name: name, Id: personIdOf(name), Role: '', Type: type });
  }
  return out.filter((p) => p.Name);
}

export function imageTag(url: string | undefined | null): string | undefined {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : undefined;
}

export interface TitleItemOptions {
  parentId?: string | null;
  seasonCount?: number;
  episodeCount?: number;
}

export function titleItem(meta: MetaPreview | Meta, g: TitleGuid, id: string, who: Identity, opts: TitleItemOptions = {}): Dto {
  const full = meta as Partial<Meta>;
  const isMovie = g.kind === 'movie';
  const genres = Array.isArray(meta.genres) ? meta.genres.filter((x) => typeof x === 'string' && x) : [];
  const imageTags: Record<string, string> = {};
  if (imageTag(meta.poster)) imageTags.Primary = imageTag(meta.poster)!;
  if (imageTag(meta.logo)) imageTags.Logo = imageTag(meta.logo)!;
  if (imageTag(meta.background)) imageTags.Thumb = imageTag(meta.background)!;

  const item: Dto = {
    Name: meta.name,
    OriginalTitle: full.originalTitle || meta.name,
    SortName: String(meta.name ?? '').toLowerCase(),
    Id: id,
    ServerId: who.serverId,
    Etag: id,
    Type: full.collection ? 'BoxSet' : isMovie ? 'Movie' : 'Series',
    MediaType: isMovie ? 'Video' : 'Unknown',
    IsFolder: full.collection||!isMovie,
    ParentId: opts.parentId ?? null,
    Overview: meta.description || null,
    ProductionYear: yearOf(meta),
    PremiereDate: premiereOf(full as MetaPreview),
    Genres: genres,
    GenreItems: genres.map((name) => ({ Name: name, Id: genreIdOf(name) })),
    CommunityRating: ratingOf(meta.imdbRating),
    OfficialRating: full.certification || null,
    RunTimeTicks: runtimeTicks(full.runtime),
    ProviderIds: providerIds(full, g),
    People: peopleOf(full),
    Studios: [...new Set([...(full.studios ?? []), ...(full.network ? [full.network] : [])])].map(Name => ({ Name })),
    Taglines: full.tagline ? [full.tagline] : [],
    Tags: [],
    ProductionLocations: full.country ? [full.country] : [],
    RemoteTrailers: (full.trailers ?? [])
      .filter((t) => t?.source)
      .slice(0, 5)
      .map((t) => ({ Name: t.type || 'Trailer', Url: /^https?:/i.test(t.source) ? t.source : `https://www.youtube.com/watch?v=${t.source}` })),
    ImageTags: imageTags,
    BackdropImageTags: imageTag(meta.background) ? [imageTag(meta.background)!] : [],
    ImageBlurHashes: {},
    UserData: userData(id),
    LocationType: 'Remote',
    PrimaryImageAspectRatio: meta.posterShape === 'landscape' ? 1.7777777777777777 : 0.6666666666666666,
    CanDelete: false,
    CanDownload: false,
    PlayAccess: 'Full',
    LockedFields: [],
    LockData: false,
    ChildCount: opts.seasonCount ?? null,
    Path: `/library/${id}`,
  };
  if (!isMovie) {
    item.Status = full.status ? (/(ended|finished|completed)/i.test(full.status) ? 'Ended' : 'Continuing') : undefined;
    item.AirDays = [];
    if (opts.episodeCount !== undefined) item.RecursiveItemCount = opts.episodeCount;
  } else {
    item.EnableMediaSourceDisplay = true;
    item.VideoType = 'VideoFile';
  }
  return item;
}

export interface SeasonInput {
  id: string;
  seriesId: string;
  seriesName: string;
  number: number;
  episodeCount: number;
  poster?: string;
}

export function seasonItem(s: SeasonInput, who: Identity): Dto {
  return {
    Name: s.number === 0 ? 'Specials' : `Season ${s.number}`,
    Id: s.id,
    ServerId: who.serverId,
    Etag: s.id,
    Type: 'Season',
    MediaType: 'Unknown',
    IsFolder: true,
    ParentId: s.seriesId,
    SeriesId: s.seriesId,
    SeriesName: s.seriesName,
    IndexNumber: s.number,
    ChildCount: s.episodeCount,
    RecursiveItemCount: s.episodeCount,
    UserData: userData(s.id),
    ImageTags: imageTag(s.poster) ? { Primary: imageTag(s.poster)! } : {},
    BackdropImageTags: [],
    ImageBlurHashes: {},
    LocationType: 'Remote',
    PrimaryImageAspectRatio: 0.6666666666666666,
    CanDelete: false,
    CanDownload: false,
    LockedFields: [],
    LockData: false,
  };
}

export interface EpisodeInput {
  id: string;
  seriesId: string;
  seasonId: string;
  seriesName: string;
  season: number;
  episode: number;
  video: MetaVideo;
  certification?: string;
  runtimeTicks?: number | null;
  backdrop?: string;
  logo?: string;
}

export function episodeItem(e: EpisodeInput, who: Identity): Dto {
  const v = e.video;
  const premiere = typeof v.released === 'string' && v.released ? v.released : null;
  const item: Dto = {
    Name: v.title || `Episode ${e.episode}`,
    Id: e.id,
    ServerId: who.serverId,
    Etag: e.id,
    Type: 'Episode',
    MediaType: 'Video',
    IsFolder: false,
    ParentId: e.seasonId,
    SeasonId: e.seasonId,
    SeasonName: e.season === 0 ? 'Specials' : `Season ${e.season}`,
    SeriesId: e.seriesId,
    SeriesName: e.seriesName,
    OfficialRating: e.certification || null,
    ParentIndexNumber: e.season,
    IndexNumber: e.episode,
    Overview: v.overview || null,
    PremiereDate: premiere,
    ProductionYear: premiere ? parseInt(premiere.slice(0, 4), 10) || null : null,
    CommunityRating: ratingOf(v.rating),
    RunTimeTicks: e.runtimeTicks ?? null,
    ProviderIds: {},
    ImageTags: imageTag(v.thumbnail) ? { Primary: imageTag(v.thumbnail)! } : {},
    BackdropImageTags: [],
    ImageBlurHashes: {},
    UserData: userData(e.id),
    LocationType: 'Remote',
    PrimaryImageAspectRatio: 1.7777777777777777,
    CanDelete: false,
    CanDownload: false,
    LockedFields: [],
    LockData: false,
    EnableMediaSourceDisplay: true,
    VideoType: 'VideoFile',
    Path: `/library/${e.id}`,
  };
  if (imageTag(e.backdrop)) {
    item.ParentBackdropItemId = e.seriesId;
    item.ParentBackdropImageTags = [imageTag(e.backdrop)!];
  }
  if (imageTag(e.logo)) {
    item.ParentLogoItemId = e.seriesId;
    item.ParentLogoImageTag = imageTag(e.logo)!;
  }
  if (premiere && Date.parse(premiere) > Date.now()) item.IsUnaired = true;
  return item;
}

const SMALL_CAPS: Record<string, string> = {
  'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ғ': 'f', 'ꜰ': 'f', 'ɢ': 'g',
  'ʜ': 'h', 'ɪ': 'i', 'ᴊ': 'j', 'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o',
  'ᴘ': 'p', 'ǫ': 'q', 'ʀ': 'r', 'ꜱ': 's', 'ᴛ': 't', 'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w',
  'ʏ': 'y', 'ᴢ': 'z',
};

export function foldLabel(text: string): string {
  let out = '';
  for (const ch of String(text ?? '').replace(/[\u200B-\u200D\u2060-\u2064\uFEFF]/g, '')) out += SMALL_CAPS[ch] ?? ch;
  return out;
}

interface LabelHints {
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  channels?: number;
  hdr?: 'HDR' | 'HDR10' | 'HDR10+' | 'DV' | 'HLG';
  bitDepth?: number;
}

const RESOLUTIONS: Array<[RegExp, number, number]> = [
  [/\b(4k|2160p|uhd)\b/i, 3840, 2160],
  [/\b(1440p|qhd)\b/i, 2560, 1440],
  [/\b(1080p|fhd|full ?hd)\b/i, 1920, 1080],
  [/\b(720p|hd)\b/i, 1280, 720],
  [/\b(576p)\b/i, 1024, 576],
  [/\b(480p|sd)\b/i, 854, 480],
];
const VIDEO_CODECS: Array<[RegExp, string]> = [
  [/\b(hevc|h\.?265|x265)\b/i, 'hevc'],
  [/\bav1\b/i, 'av1'],
  [/\b(avc|h\.?264|x264)\b/i, 'h264'],
  [/\b(vp9)\b/i, 'vp9'],
  [/\b(xvid|divx)\b/i, 'mpeg4'],
];
const AUDIO_CODECS: Array<[RegExp, string]> = [
  [/\b(truehd|true-hd|atmos)\b/i, 'truehd'],
  [/\b(dts-?hd(?: ma)?|dts-?x)\b/i, 'dts'],
  [/\bdts\b/i, 'dts'],
  [/\b(e-?ac-?3|ddp|dd\+|dolby digital plus)(?![a-z])/i, 'eac3'],
  [/\b(ac-?3|dd(?=\d)|dolby digital)(?![a-z])/i, 'ac3'],
  [/\b(aac)\b/i, 'aac'],
  [/\b(opus)\b/i, 'opus'],
  [/\b(flac)\b/i, 'flac'],
  [/\b(mp3)\b/i, 'mp3'],
];

export function parseLabelHints(label: string): LabelHints {
  const text = foldLabel(label);
  const out: LabelHints = {};
  const res = RESOLUTIONS.find(([re]) => re.test(text));
  if (res) {
    out.width = res[1];
    out.height = res[2];
  }
  const vc = VIDEO_CODECS.find(([re]) => re.test(text));
  if (vc) out.videoCodec = vc[1];
  const ac = AUDIO_CODECS.find(([re]) => re.test(text));
  if (ac) out.audioCodec = ac[1];
  const ch = /(?<!\d)(7\.1|5\.1|2\.0)(?!\d)/.exec(text);
  if (ch) out.channels = ch[1] === '7.1' ? 8 : ch[1] === '5.1' ? 6 : 2;
  if (/\b(dv|dolby ?vision)\b/i.test(text)) out.hdr = 'DV';
  else if (/\bhdr10\+/i.test(text)) out.hdr = 'HDR10+';
  else if (/\bhdr10\b/i.test(text)) out.hdr = 'HDR10';
  else if (/\bhlg\b/i.test(text)) out.hdr = 'HLG';
  else if (/\bhdr\b/i.test(text)) out.hdr = 'HDR';
  if (/\b10-?bit\b/i.test(text)) out.bitDepth = 10;
  return out;
}

export function containerOf(stream: Stream): string | null {
  const candidates = [stream.behaviorHints?.filename, stream.url].filter((x): x is string => typeof x === 'string' && x.length > 0);
  for (const c of candidates) {
    const path = c.split(/[?#]/)[0];
    const m = /\.([a-z0-9]{2,4})$/i.exec(path);
    if (m && !['json', 'php', 'html', 'htm', 'aspx'].includes(m[1].toLowerCase())) return m[1].toLowerCase();
  }
  return null;
}

export function streamLabel(stream: Stream): string {
  const parts = [stream.name, stream.title || stream.description].filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  return parts.join('\n') || 'Stream';
}

export async function mediaSourceId(url: string): Promise<string> {
  return (await sha256(`rill:msid:${url}`)).slice(0, 32);
}

export interface MediaSourceInput {
  id: string;
  url: string;
  label: string;
  container: string | null;
  size: number | null;
  filename: string | null;
  runtimeTicks: number | null;
  subtitles: Array<{ url: string; lang: string; deliveryUrl: string }>;
}

function mediaStreams(label: string, subtitles: MediaSourceInput['subtitles']): Dto[] {
  const hints = parseLabelHints(label);
  const title = [hints.height ? `${hints.height}p` : null, hints.videoCodec?.toUpperCase() ?? null, hints.hdr ?? null].filter(Boolean).join(' ') || 'Video';
  const range = hints.hdr ? 'HDR' : 'SDR';
  const rangeType = hints.hdr === 'DV' ? 'DOVI' : hints.hdr === 'HDR10+' ? 'HDR10Plus' : hints.hdr ?? 'SDR';
  const streams: Dto[] = [
    {
      Type: 'Video',
      Index: 0,
      Codec: hints.videoCodec,
      Width: hints.width,
      Height: hints.height,
      BitDepth: hints.bitDepth,
      IsDefault: true,
      IsForced: false,
      IsHearingImpaired: false,
      IsExternal: false,
      IsInterlaced: false,
      IsTextSubtitleStream: false,
      SupportsExternalStream: false,
      VideoRange: range,
      VideoRangeType: rangeType,
      DisplayTitle: title,
      AspectRatio: hints.width ? '16:9' : undefined,
    },
    {
      Type: 'Audio',
      Index: 1,
      Codec: hints.audioCodec,
      Channels: hints.channels,
      IsDefault: true,
      IsForced: false,
      IsHearingImpaired: false,
      IsExternal: false,
      IsInterlaced: false,
      IsTextSubtitleStream: false,
      SupportsExternalStream: false,
      DisplayTitle: [hints.audioCodec?.toUpperCase(), hints.channels ? `${hints.channels === 8 ? '7.1' : hints.channels === 6 ? '5.1' : '2.0'}` : null].filter(Boolean).join(' ') || 'Audio',
    },
  ];
  subtitles.forEach((s, i) => {
    const codec = subtitleFormat(s.url);
    streams.push({
      Type: 'Subtitle',
      Index: 2 + i,
      Codec: codec,
      Language: s.lang,
      DisplayLanguage: s.lang,
      DisplayTitle: `${s.lang} (${codec.toUpperCase()})`,
      Title: s.lang,
      IsDefault: false,
      IsForced: false,
      IsHearingImpaired: false,
      IsExternal: true,
      IsTextSubtitleStream: true,
      SupportsExternalStream: true,
      DeliveryMethod: 'External',
      DeliveryUrl: s.deliveryUrl,
      IsExternalUrl: false,
      Path: s.url,
    });
  });
  return streams;
}

export function subtitleFormat(url: string): string {
  const m = /\.(srt|vtt|ass|ssa|sub|ttml|dfxp)(?:[?#]|$)/i.exec(url);
  return m ? m[1].toLowerCase() : 'srt';
}

export function subtitleContentType(fmt: string): string {
  switch (fmt) {
    case 'vtt': return 'text/vtt; charset=utf-8';
    case 'ass':
    case 'ssa': return 'text/x-ssa; charset=utf-8';
    case 'ttml':
    case 'dfxp': return 'application/ttml+xml; charset=utf-8';
    case 'sub': return 'text/plain; charset=utf-8';
    default: return 'application/x-subrip; charset=utf-8';
  }
}

export function mediaSource(input: MediaSourceInput): Dto {
  return {
    Protocol: 'Http',
    Id: input.id,
    Path: input.url,
    DirectStreamUrl: input.url,
    Type: 'Default',
    Container: input.container,
    Size: input.size,
    Name: input.label.replace(/\s*[\r\n]+\s*/g, ' · ').replace(/\s{2,}/g, ' ').trim().slice(0, 160),
    IsRemote: true,
    ETag: input.id,
    RunTimeTicks: input.runtimeTicks,
    ReadAtNativeFramerate: false,
    IgnoreDts: false,
    IgnoreIndex: false,
    GenPtsInput: false,
    SupportsTranscoding: false,
    SupportsDirectStream: true,
    SupportsDirectPlay: true,
    IsInfiniteStream: false,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiresLooping: false,
    SupportsProbing: true,
    VideoType: 'VideoFile',
    MediaStreams: mediaStreams(input.label, input.subtitles),
    MediaAttachments: [],
    Formats: [],
    RequiredHttpHeaders: {},
    DefaultAudioStreamIndex: 1,
    DefaultSubtitleStreamIndex: -1,
    HasSegments: false,
  };
}

export function placeholderSource(itemId: string): Dto {
  return {
    Protocol: 'Http',
    Id: itemId,
    Path: '/placeholder.mp4',
    Type: 'Placeholder',
    Container: 'mp4',
    Name: 'Streams resolve on play',
    IsRemote: true,
    ETag: itemId,
    SupportsTranscoding: false,
    SupportsDirectStream: true,
    SupportsDirectPlay: true,
    SupportsProbing: false,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiresLooping: false,
    VideoType: 'VideoFile',
    MediaAttachments: [],
    Formats: [],
    RequiredHttpHeaders: {},
    MediaStreams: [{ Type: 'Video', Index: 0, Codec: 'h264', IsDefault: true, IsForced: false, IsExternal: false, IsTextSubtitleStream: false, SupportsExternalStream: false, DisplayTitle: 'Video' }],
  };
}

export function subtitleEntries(subs: Subtitle[]): Subtitle[] {
  return subs.filter((s) => s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url));
}

export function genreDto(name: string, who: Identity): Dto {
  return {
    Name: name,
    Id: genreIdOf(name),
    ServerId: who.serverId,
    Type: 'Genre',
    UserData: userData(genreIdOf(name)),
    IsFolder: false,
    ImageTags: {},
    BackdropImageTags: [],
    ImageBlurHashes: {},
  };
}

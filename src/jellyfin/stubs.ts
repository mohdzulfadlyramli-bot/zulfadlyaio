import type { Hono } from 'hono';
import type { JfEnv } from './request';

export const EMPTY_LIST = { Items: [] as unknown[], TotalRecordCount: 0, StartIndex: 0 };

const EMPTY_LIST_ROUTES = [
  '/years',
  '/studios',
  '/persons',
  '/artists',
  '/artists/albumartists',
  '/musicgenres',
  '/channels',
  '/playlists',
  '/collections',
  '/trailers',
  '/items/suggestions',
  '/users/:uid/suggestions',
  '/items/:id/intros',
  '/users/:uid/items/intros',
  '/users/:uid/items/:id/intros',
  '/items/:id/specialfeatures',
  '/users/:uid/items/:id/specialfeatures',
  '/items/:id/localtrailers',
  '/users/:uid/items/:id/localtrailers',
  '/items/:id/themesongs',
  '/items/:id/themevideos',
  '/items/:id/chapters',
  '/videos/:id/additionalparts',
  '/system/activitylog/entries',
  '/livetv/programs',
  '/livetv/recordings',
  '/livetv/timers',
  '/livetv/seriestimers',
  '/livetv/channels',
  '/livetv/programs/recommended',
  '/livetv/recordings/folders',
];

const EMPTY_ARRAY_ROUTES = [
  '/plugins',
  '/scheduledtasks',
  '/packages',
  '/repositories',
  '/devices',
  '/notifications/types',
  '/notifications/services',
  '/auth/keys',
  '/auth/passwordresetproviders',
  '/auth/providers',
  '/environment/drives',
  '/library/physicalpaths',
  '/sessions/syncplay/list',
  '/syncplay/list',
  '/localization/cultures',
  '/localization/countries',
  '/localization/parentalratings',
];

export function displayPreferences(id: string): Record<string, unknown> {
  return {
    Id: id,
    SortBy: 'SortName',
    SortOrder: 'Ascending',
    RememberIndexing: false,
    RememberSorting: false,
    PrimaryImageHeight: 250,
    PrimaryImageWidth: 250,
    ScrollDirection: 'Horizontal',
    ShowBackdrop: true,
    ShowSidebar: false,
    Client: 'emby',
    CustomPrefs: {},
  };
}

export function registerStubs(app: Hono<JfEnv>): void {
  for (const path of EMPTY_LIST_ROUTES) app.get(path, (c) => c.json(EMPTY_LIST));
  for (const path of EMPTY_ARRAY_ROUTES) app.get(path, (c) => c.json([]));

  app.get('/items/:id/thememedia', (c) => {
    const empty = { ...EMPTY_LIST, OwnerId: c.req.param('id') };
    return c.json({ ThemeVideosResult: empty, ThemeSongsResult: empty, SoundtrackSongsResult: empty });
  });

  app.get('/livetv/info', (c) => c.json({ Services: [], IsEnabled: false, EnabledUsers: [] }));

  app.get('/branding/configuration', (c) => c.json({ LoginDisclaimer: '', CustomCss: '', SplashscreenEnabled: false }));
  app.get('/branding/splashscreen', (c) => c.body(null, 404));
  app.get('/branding/css', (c) => c.text('', 200, { 'content-type': 'text/css' }));
  app.get('/branding/css.css', (c) => c.text('', 200, { 'content-type': 'text/css' }));

  app.get('/localization/options', (c) => c.json([{ Name: 'English', Value: 'en-US' }]));

  app.get('/displaypreferences/:id', async (c) => {
    const jf=c.get('jf'),ctx=jf.ctx,id=c.req.param('id'),client=jf.q('Client')??'';
    const stored=ctx.env.DB ? await ctx.env.DB.prepare('SELECT value FROM preferences WHERE scope=? AND profile=? AND id=? AND client=?').bind(ctx.scope,ctx.profile?.id??'',id,client).first<{value:string}>():null;
    return c.json({...displayPreferences(id),Client:client||'emby',...(stored?JSON.parse(stored.value):{}),Id:id});
  });
  app.post('/displaypreferences/:id', async (c) => {
    const jf=c.get('jf'),ctx=jf.ctx;
    if(!ctx.env.DB) return c.json({error:'Durable storage is required to save preferences'},503);
    const value=JSON.stringify(jf.body);
    if(new TextEncoder().encode(value).length>65536) return c.json({error:'Preferences are too large'},413);
    await ctx.env.DB.prepare('INSERT INTO preferences(scope,profile,id,client,value) VALUES(?,?,?,?,?) ON CONFLICT(scope,profile,id,client) DO UPDATE SET value=excluded.value').bind(ctx.scope,ctx.profile?.id??'',c.req.param('id'),jf.q('Client')??'',value).run();
    return c.body(null,204);
  });

  app.get('/system/endpoint', (c) => c.json({ IsLocal: false, IsInNetwork: false }));
  app.get('/system/configuration', (c) => c.json({ EnableMetrics: false, ServerName: c.get('jf').ctx.cfg.name || 'Rill' }));
  app.get('/system/logs', (c) => c.json([]));

  app.get('/startup/configuration', (c) => c.json({ UICulture: 'en-US', MetadataCountryCode: 'US', PreferredMetadataLanguage: 'en' }));
  app.get('/startup/user', (c) => c.json({ Name: c.get('jf').ctx.cfg.jellyfin.username, Password: '' }));
  app.get('/startup/firstuser', (c) => c.json({ Name: c.get('jf').ctx.cfg.jellyfin.username, Password: '' }));
  app.post('/startup/*', (c) => c.body(null, 204));

  app.get('/items/counts', (c) =>
    c.json({
      MovieCount: 0, SeriesCount: 0, EpisodeCount: 0, ArtistCount: 0, ProgramCount: 0, TrailerCount: 0,
      SongCount: 0, AlbumCount: 0, MusicVideoCount: 0, BoxSetCount: 0, BookCount: 0, ItemCount: 0,
    }),
  );

}

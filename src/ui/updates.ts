import type { Context, Hono } from 'hono';
import type { Ctx } from '../context';
import type { Env } from '../env';
import { configureUpdates, configureUpdateMonitor, disconnectUpdates, requestUpdate, updateStatus, UpdateError } from '../storage/updates';

type App = { Variables: { ctx?: Ctx }; Bindings: Env };

export function mountUpdateRoutes(router: Hono<App>, authorized: (c: Context<App>) => Promise<boolean>): void {
  router.use('/api/updates/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (c.req.header('origin') !== new URL(c.req.url).origin) return c.json({ error: 'Open Rill to manage updates.' }, 403);
    if (!(await authorized(c))) return c.json({ error: 'Sign in first.' }, 401);
    if (c.req.method !== 'POST' || c.req.header('content-type')?.split(';')[0].trim() !== 'application/json') {
      return c.json({ error: 'Send update requests from Rill.' }, 400);
    }
    await next();
  });

  router.post('/api/updates/:action', async (c) => {
    try {
      switch (c.req.param('action')) {
        case 'status': return c.json(await updateStatus(c.env));
        case 'configure': {
          let body: unknown;
          try { body = await c.req.json(); } catch { throw new UpdateError('Choose your update settings and try again.'); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UpdateError('Choose your update settings and try again.');
          const input = body as Record<string, unknown>;
          await configureUpdates(c.env, input.hook, input.daily);
          return c.json(await updateStatus(c.env));
        }
        case 'disconnect':
          await disconnectUpdates(c.env);
          return c.json(await updateStatus(c.env));
        case 'monitor': {
          let body: unknown;
          try { body = await c.req.json(); } catch { throw new UpdateError('Enter your build status connection details.'); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UpdateError('Enter your build status connection details.');
          await configureUpdateMonitor(c.env, body as Record<string, unknown>);
          return c.json(await updateStatus(c.env));
        }
        case 'start': return c.json(await requestUpdate(c.env), 202);
        default: return c.json({ error: 'Unknown update action.' }, 404);
      }
    } catch (error) {
      return c.json({ error: error instanceof UpdateError ? error.message : 'Could not manage updates. Try again.' },
        error instanceof UpdateError ? error.status : 503);
    }
  });
}

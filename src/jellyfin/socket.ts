import type { Ctx } from '../context';
import { tokenOf, verifyToken } from './auth';

export async function handleJellyfinSocket(ctx: Ctx, req: Request): Promise<Response> {
  if ((req.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
    return new Response('Expected a websocket upgrade', { status: 426, headers: { upgrade: 'websocket' } });
  }
  const token = tokenOf(req);
  if (!token || !(await verifyToken(ctx, token))) {
    return new Response('Unauthorized', { status: 401 });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  const send = (MessageType: string, Data: unknown = null) => {
    try {
      server.send(JSON.stringify({ MessageType, Data }));
    } catch {
    }
  };

  send('ForceKeepAlive', 60);

  server.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    try {
      const msg = JSON.parse(event.data) as { MessageType?: string };
      if (msg?.MessageType === 'KeepAlive') send('KeepAlive');
    } catch {
    }
  });

  server.addEventListener('close', () => {
    try {
      server.close();
    } catch {
    }
  });

  return new Response(null, { status: 101, webSocket: client });
}

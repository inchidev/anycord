import { DurableObject } from 'cloudflare:workers';

const roomPattern = /^[a-z0-9-]{1,40}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, runtime: 'celld', mode: 'local', nodes: 1 });
    }
    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(history|ws)$/);
    if (match) {
      if (!roomPattern.test(match[1])) return new Response('Invalid room', { status: 400 });
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) return new Response('Invalid origin', { status: 403 });
      return env.ROOMS.getByName(match[1]).fetch(request);
    }
    if (url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
};

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      text TEXT NOT NULL,
      sent_at INTEGER NOT NULL
    )`);
  }

  history() {
    return this.ctx.storage.sql.exec(
      'SELECT id, name, text, sent_at AS sentAt FROM (SELECT * FROM messages ORDER BY seq DESC LIMIT 100) ORDER BY seq'
    ).toArray();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/history')) return Response.json(this.history());
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }
    const name = (url.searchParams.get('name') || 'Guest').trim().slice(0, 32) || 'Guest';
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ name });
    server.send(JSON.stringify({ type: 'history', messages: this.history() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 8192) {
      ws.send(JSON.stringify({ type: 'error', message: 'Message is too large.' }));
      return;
    }
    let input;
    try { input = JSON.parse(raw); } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message.' }));
      return;
    }
    if (!input || typeof input.id !== 'string' || !/^[\w-]{1,64}$/.test(input.id)
      || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000) {
      ws.send(JSON.stringify({ type: 'error', message: 'Use between 1 and 2,000 characters.' }));
      return;
    }
    const message = {
      id: input.id,
      name: ws.deserializeAttachment().name,
      text: input.text.trim(),
      sentAt: Date.now(),
    };
    // A stable client ID prevents duplicate writes if a send is retried.
    const inserted = this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO messages (id, name, text, sent_at) VALUES (?, ?, ?, ?) RETURNING id',
      message.id, message.name, message.text, message.sentAt
    ).toArray();
    if (!inserted.length) return;
    this.ctx.storage.sql.exec('DELETE FROM messages WHERE seq <= (SELECT MAX(seq) - 100 FROM messages)');
    const event = JSON.stringify({ type: 'message', message });
    for (const client of this.ctx.getWebSockets()) {
      try { client.send(event); } catch { /* A disconnected client will reconnect and load history. */ }
    }
  }

  async webSocketClose(ws, code, reason) { ws.close(code, reason); }
  async webSocketError(ws) { ws.close(1011, 'Connection error'); }
}

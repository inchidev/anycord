// Run behind HTTPS at an explicitly approved origin. Requires Node with node:sqlite.
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
export function createReceiver({ secret, databasePath }) {
  if (!secret) throw new Error('Set ANYCORD_SIGNING_SECRET')
  const db = new DatabaseSync(databasePath)
  db.exec('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, hash TEXT NOT NULL, response TEXT NOT NULL)')
  const server = createServer(async (request, response) => {
    const reply = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)) }
    try {
      if (request.method !== 'POST' || request.url !== '/anycord') return reply(404, { error: 'Not found' })
      const chunks = []; let size = 0
      for await (const chunk of request) { size += chunk.length; if (size > 20_000) return reply(413, { error: 'Too large' }); chunks.push(chunk) }
      const raw = Buffer.concat(chunks), timestamp = request.headers['x-anycord-timestamp'], signature = request.headers['x-anycord-signature']
      if (typeof timestamp !== 'string' || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || typeof signature !== 'string' || !/^v1=[a-f0-9]{64}$/.test(signature)) return reply(401, { error: 'Invalid or expired signature' })
      const expected = createHmac('sha256', secret).update(timestamp + '.').update(raw).digest()
      if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'))) return reply(401, { error: 'Invalid signature' })
      const event = JSON.parse(raw.toString('utf8'))
      if (typeof event.id !== 'string' || event.id.length > 128 || request.headers['x-anycord-event-id'] !== event.id || !['message.created', 'command.invoked'].includes(event.type) || !event.data) return reply(400, { error: 'Invalid event' })
      const hash = createHash('sha256').update(raw).digest('hex'), saved = db.prepare('SELECT hash, response FROM events WHERE id = ?').get(event.id)
      if (saved) {
        if (saved.hash !== hash) return reply(409, { error: 'Event ID already used with another payload' })
        return reply(200, JSON.parse(saved.response))
      }
      // This durable insert is the example's side effect. For other side effects,
      // use the same event ID as their idempotency key or a transactional outbox.
      const result = event.type === 'command.invoked' ? { text: event.data.name === 'hello' ? `Hello ${event.data.arguments?.name || 'friend'}!` : 'Pong from the example app!' } : { ok: true }
      db.prepare('INSERT INTO events (id, hash, response) VALUES (?, ?, ?)').run(event.id, hash, JSON.stringify(result))
      return reply(200, result)
    } catch { return reply(400, { error: 'Invalid request' }) }
  })
  server.on('close', () => db.close())
  return server
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createReceiver({ secret: process.env.ANYCORD_SIGNING_SECRET, databasePath: process.env.ANYCORD_EVENTS_DB || 'app-events.sqlite' })
  server.listen(Number(process.env.PORT || 8788), '127.0.0.1', () => console.log('Anycord example receiver listening'))
}

import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createReceiver } from '../examples/apps/event-receiver.mjs'
const dir = await mkdtemp(join(tmpdir(), 'anycord-app-examples-')), secret = 'synthetic-signing-secret'
let server, ci
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const close = server => new Promise(resolve => server.close(resolve))
try {
  server = createReceiver({ secret, databasePath: join(dir, 'events.sqlite') }); await listen(server)
  const event = { id: crypto.randomUUID(), type: 'command.invoked', createdAt: Date.now(), data: { name: 'hello', arguments: { name: 'World' } } }, raw = JSON.stringify(event)
  async function send(payload = raw, { signingSecret = secret, timestamp = String(Math.floor(Date.now() / 1000)), id = event.id } = {}) {
    return fetch(`http://127.0.0.1:${server.address().port}/anycord`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Anycord-Event-Id': id, 'X-Anycord-Timestamp': timestamp, 'X-Anycord-Signature': `v1=${createHmac('sha256', signingSecret).update(`${timestamp}.${payload}`).digest('hex')}` }, body: payload })
  }
  assert.equal((await send(raw, { signingSecret: 'wrong' })).status, 401)
  assert.equal((await send(raw, { timestamp: String(Math.floor(Date.now() / 1000) - 600) })).status, 401)
  assert.equal((await send(raw, { id: 'wrong-id' })).status, 400)
  const accepted = await send(); assert.equal(accepted.status, 200); assert.deepEqual(await accepted.json(), { text: 'Hello World!' })
  await close(server); server = createReceiver({ secret, databasePath: join(dir, 'events.sqlite') }); await listen(server)
  assert.deepEqual(await (await send()).json(), { text: 'Hello World!' }, 'A receiver restart preserves the response for duplicate events')
  assert.equal((await send(JSON.stringify({ ...event, data: { name: 'hello', arguments: { name: 'Changed' } } }))).status, 409)
  const posts = []
  ci = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part
    posts.push({ path: request.url, token: request.headers.authorization, body: JSON.parse(raw) })
    response.writeHead(201, { 'Content-Type': 'application/json' }); response.end('{}')
  }); await listen(ci)
  const run = () => promisify(execFile)(process.execPath, ['examples/apps/ci-webhook.mjs'], { env: { ...process.env, ANYCORD_URL: `http://127.0.0.1:${ci.address().port}`, ANYCORD_APP_ID: 'synthetic-app-id', ANYCORD_APP_TOKEN: 'synthetic-token', ANYCORD_CHANNEL_ID: 'general', ANYCORD_DELIVERY_ID: 'stable-ci-run', CI_JOB_STATUS: 'success', GITHUB_REPOSITORY: 'example/repo', GITHUB_SHA: '0123456789abcdef' } })
  await run(); await run()
  assert.equal(posts.length, 2); assert.deepEqual(posts[0], posts[1], 'CI retries use the same UUID and payload')
  assert.equal(posts[0].path, '/api/apps/synthetic-app-id/messages'); assert.equal(posts[0].token, 'Bearer synthetic-token'); assert.equal(posts[0].body.text, 'example/repo: build success (0123456)')
  assert.match(posts[0].body.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  console.log('PASS: runnable CI webhook, stable retry UUID, receiver signature/expiry/ID checks, durable deduplication and saved responses across restart')
} finally { await close(server); if (ci) await close(ci); await rm(dir, { recursive: true, force: true }) }

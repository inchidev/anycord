import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { IncomingWebhook } from '@slack/webhook'
export async function slackWebhookChecks({ mf, db, base, request, owner, member, cfg, other, otherChannel, engine }) {
  const builds = (await request('/api/workspaces/main/channels', { who: owner, method: 'POST', body: { name: 'builds', kind: 'text' }, status: 201 })).id
  const config = { ...cfg, name: 'Slack CI', channelIds: ['general', builds] }
  const bot = await request('/api/workspaces/main/apps', { who: owner, method: 'POST', body: config, status: 201 })
  const appPath = `/api/workspaces/main/apps/${bot.app.id}`, admin = appPath + '/slack-webhooks'
  const create = (channelId = 'general') => request(admin, { who: owner, method: 'POST', body: { channelId }, status: 201 })
  async function send(url, { text = 'Slack build passed', body, raw, status = 200, expected = 'ok', method = 'POST', headers = {} } = {}) {
    const response = await mf.dispatchFetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(method === 'GET' ? {} : { body: raw ?? JSON.stringify(body ?? { text }) }) })
    const result = await response.text()
    assert.equal(response.status, status, `${engine} Slack status: ${result}`)
    assert.equal(result, expected)
    assert(response.headers.get('Content-Type').startsWith('text/plain'))
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    if (status === 429) assert.equal(response.headers.get('Retry-After'), '60')
    return result
  }
  await request(admin, { who: member, status: 403 })
  await request(admin, { who: member, method: 'POST', body: { channelId: 'general' }, status: 403 })
  await request(admin, { who: owner, method: 'POST', body: { channelId: otherChannel }, status: 403 })
  const hook = await create(), hook2 = await create(builds)
  const secret = new URL(hook.url).pathname.split('/').at(-1)
  const saved = await db.prepare('SELECT * FROM app_slack_webhooks WHERE id = ?').bind(hook.id).first()
  assert.notEqual(saved.token_hash, secret); assert(!JSON.stringify(saved).includes(hook.url))
  const list = await request(admin, { who: owner })
  assert.equal(list.length, 2); assert(list.every(row => !('url' in row) && !('tokenHash' in row)))
  await request(admin, { who: owner, method: 'POST', body: { channelId: 'general' }, status: 409 })
  await send(hook.url.replace(secret, 'a'.repeat(64)), { status: 404, expected: 'invalid_token', headers: { Authorization: `Bearer ${bot.token}` } })
  await send(hook.url.replace('/services/main/', `/services/${other}/`), { status: 404, expected: 'invalid_token' })
  await send(hook.url, { method: 'GET', status: 405, expected: 'method_not_allowed' })
  await send(hook.url, { raw: '{broken', status: 400, expected: 'invalid_payload' })
  await send(hook.url, { body: {}, status: 400, expected: 'no_text' })
  await send(hook.url, { text: '   ', status: 400, expected: 'no_text' })
  for (const body of [{ text: 42 }, { text: 'ok', unexpected: true }]) await send(hook.url, { body, status: 400, expected: 'invalid_payload' })
  for (const field of ['blocks', 'attachments', 'thread_ts', 'metadata']) await send(hook.url, { body: { text: 'fallback', [field]: [] }, status: 400, expected: 'unsupported_payload' })
  const queuedBefore = await db.prepare('SELECT count(*) AS n FROM app_outbox').first('n')
  await send(hook.url, { body: { text: 'Fixed identity', channel: otherChannel, username: 'Impersonated', icon_url: 'https://example.com/forged.png', icon_emoji: ':robot_face:', mrkdwn: false } })
  const identity = await db.prepare('SELECT m.channel_id, u.name, a.name AS app_name FROM messages m JOIN users u ON u.id = m.author_id JOIN server_apps a ON a.bot_user_id = u.id WHERE m.text = ?').bind('Fixed identity').first()
  assert.equal(identity.channel_id, 'general'); assert.equal(identity.app_name, 'Slack CI'); assert(identity.name.startsWith('app:'))
  await send(hook.url, { text: '  Preserve whitespace\n' })
  assert.equal(await db.prepare('SELECT text FROM messages WHERE app_id = ? AND text = ?').bind(bot.app.id, '  Preserve whitespace\n').first('text'), '  Preserve whitespace\n')
  await send(hook.url, { text: 'Repeated notification' }); await send(hook.url, { text: 'Repeated notification' })
  assert.equal(await db.prepare('SELECT count(*) AS n FROM messages WHERE app_id = ? AND text = ?').bind(bot.app.id, 'Repeated notification').first('n'), 2)
  const headers = { 'Idempotency-Key': 'stable-ci-job' }
  await Promise.all(Array.from({ length: 3 }, () => send(hook.url, { text: 'Idempotent', headers })))
  assert.equal(await db.prepare('SELECT count(*) AS n FROM messages WHERE app_id = ? AND text = ?').bind(bot.app.id, 'Idempotent').first('n'), 1)
  await send(hook.url, { text: 'Changed', headers, status: 409, expected: 'idempotency_conflict' })
  await send(hook.url, { text: 'bad key', headers: { 'Idempotency-Key': 'spaces are invalid' }, status: 400, expected: 'invalid_payload' })
  await send(hook2.url, { text: 'Idempotent', headers })
  assert.equal(await db.prepare('SELECT count(*) AS n FROM messages WHERE app_id = ? AND text = ?').bind(bot.app.id, 'Idempotent').first('n'), 2, 'Keys are scoped to individual webhook URLs')
  assert.equal(await db.prepare('SELECT count(*) AS n FROM app_outbox').first('n'), queuedBefore, 'Slack bot messages cannot recursively generate events')
  // Use the real official Slack SDK over a local HTTP bridge into the actual Worker.
  const bridge = createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part)
    const response = await mf.dispatchFetch(base + req.url, { method: req.method, headers: req.headers, body: Buffer.concat(chunks) })
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()))
  })
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve))
  try {
    const localURL = `http://127.0.0.1:${bridge.address().port}${new URL(hook.url).pathname}`
    const sdk = new IncomingWebhook(localURL)
    assert.deepEqual(await sdk.send({ text: 'Official Slack SDK' }), { text: 'ok' })
    assert.equal(await db.prepare('SELECT count(*) AS n FROM messages WHERE app_id = ? AND text = ?').bind(bot.app.id, 'Official Slack SDK').first('n'), 1)
  } finally { await new Promise(resolve => bridge.close(resolve)) }
  const rotated = await request(`${admin}/${hook.id}/rotate`, { who: owner, method: 'POST' })
  assert.notEqual(rotated.url, hook.url)
  await send(hook.url, { status: 404, expected: 'invalid_token' }); await send(rotated.url)
  await request(appPath, { who: owner, method: 'PUT', body: { ...config, enabled: false } })
  await send(rotated.url, { status: 403, expected: 'action_prohibited' })
  await request(appPath, { who: owner, method: 'PUT', body: config }); await send(rotated.url)
  const policy = await request('/api/installation/apps', { who: owner })
  await request('/api/installation/apps', { who: owner, method: 'PUT', body: { ...policy, enabled: false } })
  await send(rotated.url, { status: 403, expected: 'action_prohibited' })
  await request('/api/installation/apps', { who: owner, method: 'PUT', body: policy })
  await request(appPath, { who: owner, method: 'PUT', body: { ...config, channelIds: [builds] } })
  await send(rotated.url, { status: 404, expected: 'invalid_token' })
  await request(appPath, { who: owner, method: 'PUT', body: config })
  await send(rotated.url, { status: 404, expected: 'invalid_token' })
  const recreated = await create()
  await request(`${admin}/${recreated.id}`, { who: owner, method: 'DELETE' })
  await send(recreated.url, { status: 404, expected: 'invalid_token' })
  const latest = await create()
  let finishBody
  const encoder = new TextEncoder()
  const streamingBody = new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode('{"text":'))
    finishBody = () => { controller.enqueue(encoder.encode('"Racing revocation"}')); controller.close() }
  } })
  const inFlight = mf.dispatchFetch(latest.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: streamingBody, duplex: 'half' }).then(response => ({ response }), error => ({ error }))
  await request(appPath + '/rotate', { who: owner, method: 'POST' })
  finishBody()
  const denied = await inFlight
  // Revocation can reject headers before the unfinished upload reaches the
  // Worker. Undici can report EPIPE/ECONNRESET instead of delivering its 403.
  // The durable no-write check and subsequent 404 also prove the runtime is
  // alive and the credential is revoked; other transport failures still fail.
  if (denied.error) assert(['EPIPE', 'ECONNRESET'].includes(denied.error.cause?.code), 'Only an early upload termination is expected')
  else { assert([403, 404].includes(denied.response.status)); await denied.response.body?.cancel() }
  assert.equal(await db.prepare('SELECT count(*) AS n FROM messages WHERE app_id = ? AND text = ?').bind(bot.app.id, 'Racing revocation').first('n'), 0, 'A request whose body finishes after revocation cannot post')
  await send(latest.url, { status: 404, expected: 'invalid_token' }); await send(hook2.url, { status: 404, expected: 'invalid_token' })
  const final = await create()
  await request(appPath, { who: owner, method: 'DELETE' })
  await send(final.url, { status: 404, expected: 'invalid_token' })
  const limited = await request('/api/workspaces/main/apps', { who: owner, method: 'POST', body: { ...config, name: 'Slack limited' }, status: 201 })
  const limitedAdmin = `/api/workspaces/main/apps/${limited.app.id}/slack-webhooks`
  const limitedHook = await request(limitedAdmin, { who: owner, method: 'POST', body: { channelId: 'general' }, status: 201 })
  const anotherHook = await request(limitedAdmin, { who: owner, method: 'POST', body: { channelId: builds }, status: 201 })
  for (let i = 0; i < 30; i++) await send(i % 2 ? anotherHook.url : limitedHook.url)
  await send(limitedHook.url, { status: 429, expected: 'rate_limited' })
  console.log(`PASS ${engine}: real Slack SDK; text/ok wire contract; bound identity/channel; strict payloads; independent URL secrets, rotation and revocation; durable optional idempotency; no recursion; shared app rate limits`)
}

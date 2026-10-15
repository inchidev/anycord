import assert from 'node:assert/strict'
import { slackWebhookChecks } from './test-slack-webhooks.mjs'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
const dir = await mkdtemp(join(tmpdir(), 'anycord-apps-')), base = 'https://anycord.test'
let mf
try {
  for (const engine of ['cloudflare', 'celld']) {
    const deliveries = [], effects = new Set(), secrets = new Map()
    let failure = 0, gate = null
    const provider = async request => {
      assert.equal(new URL(request.url).origin, 'https://hooks.example.com')
      assert.equal(request.headers.get('Authorization'), null, 'Human and bot credentials never travel to app endpoints')
      const raw = await request.text(), event = JSON.parse(raw), timestamp = request.headers.get('X-Anycord-Timestamp')
      const secret = secrets.get(new URL(request.url).pathname)
      assert(secret)
      assert.equal(request.headers.get('X-Anycord-Event-Id'), event.id)
      assert.equal(request.headers.get('X-Anycord-Signature'), `v1=${createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')}`)
      assert(Math.abs(Date.now() / 1000 - Number(timestamp)) < 60)
      deliveries.push(event)
      if (gate) { gate.seen(); await gate.wait }
      if (failure) return new Response('provider down', { status: failure })
      effects.add(event.id)
      return Response.json(event.type === 'command.invoked' ? { text: `Hello ${event.data.arguments.name}` } : { ok: true })
    }
    const passwordFallback = fileURLToPath(new URL('./password.mjs', import.meta.resolve('@better-auth/utils/password')))
    await build({ stdin: { contents: `import handler from './worker/${engine === 'celld' ? 'index' : 'cloudflare'}'; export { WorkspaceHub, ChatRoom } from './worker/index'; import { flushAppEvents } from './worker/apps'; export default { ...handler, async fetch(request, env) { if (new URL(request.url).pathname === '/_test/flush') { await flushAppEvents(env); return Response.json({ok:true}) } const pending = []; const response = await handler.fetch(request, env, { waitUntil: p => pending.push(p) }); await Promise.all(pending); return response } }`, resolveDir: process.cwd(), loader: 'ts' }, outfile: join(dir, `${engine}.mjs`), bundle: true, format: 'esm', target: 'es2022', conditions: ['workerd', 'worker', 'browser'], alias: { '@better-auth/utils/password': passwordFallback }, external: ['cloudflare:*', 'node:*'], plugins: [{ name: 'fixed-rate-window', setup(builder) {
      // Keep rate-limit assertions in one window even when CI crosses a minute.
      // Only the Hub bucket clock is pinned; auth expiry and delivery clocks stay real.
      builder.onLoad({ filter: /worker\/hub\.ts$/ }, async ({ path }) => {
        const source = await readFile(path, 'utf8'), bucket = 'const bucket = Math.floor(Date.now() / 60_000)'
        assert(source.includes(bucket))
        return { contents: source.replace(bucket, 'const bucket = 1'), loader: 'ts' }
      })
    } }] })
    mf = new Miniflare(convertV4MiniflareOptions({ modules: true, modulesRoot: dir, scriptPath: join(dir, `${engine}.mjs`), compatibilityDate: '2026-10-14', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], durableObjects: { HUBS: { className: 'WorkspaceHub', useSQLite: true }, ROOMS: { className: 'ChatRoom', useSQLite: true } }, cf: false,
      bindings: { AUTH_BASE_URL: base, APP_SECRET: crypto.randomUUID(), MIGRATION_TOKEN: 'migration' }, serviceBindings: { ASSETS: () => new Response('Anycord') }, outboundService: provider }))
    await mf.ready
    const db = await mf.getD1Database('DB'), actor = () => new Map(), owner = actor(), member = actor()
    async function request(path, { who = actor(), method = 'GET', body, status = 200, token, headers = {} } = {}) {
      const response = await mf.dispatchFetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base,
        cookie: [...who].map(([k, v]) => `${k}=${v}`).join('; '), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0], i = pair.indexOf('='); who.set(pair.slice(0, i), pair.slice(i + 1)) }
      const raw = await response.text()
      assert.equal(response.status, status, `${engine} ${method} ${path}: ${raw}`)
      return raw ? JSON.parse(raw) : null
    }
    await request('/api/_migrate', { method: 'POST', body: {}, headers: { 'X-Migration-Token': 'migration' } })
    const password = 'correct-horse-battery'
    await request('/api/auth/register', { who: owner, method: 'POST', body: { name: 'owner', password }, status: 201 })
    const memberUser = (await request('/api/auth/register', { who: member, method: 'POST', body: { name: 'member', password }, status: 201 })).user
    const cfg = { name: 'Build Bot', avatarUrl: 'https://example.com/bot.png', kind: 'webhook', channelIds: ['general'], enabled: true, endpointUrl: '', events: [], commands: [] }
    const install = (body = cfg, status = 201) => request('/api/workspaces/main/apps', { who: owner, method: 'POST', body, status })
    await install(cfg, 403)
    await request('/api/installation/apps', { who: member, status: 403 })
    await request('/api/installation/apps', { who: member, method: 'PUT', body: { enabled: true, allowedOrigins: [] }, status: 403 })
    for (const origin of ['http://hooks.example.com', 'https://127.0.0.1', 'https://[::1]', 'https://service.local', 'https://a@hooks.example.com', 'https://hooks.example.com/path']) await request('/api/installation/apps', { who: owner, method: 'PUT', body: { enabled: true, allowedOrigins: [origin] }, status: 400 })
    const policy = { enabled: true, allowedOrigins: ['https://hooks.example.com'] }
    await request('/api/installation/apps', { who: owner, method: 'PUT', body: policy })
    await request('/api/workspaces/main/apps', { who: member, status: 403 })
    await request('/api/workspaces/main/apps', { who: member, method: 'POST', body: cfg, status: 403 })
    const other = (await request('/api/workspaces', { who: owner, method: 'POST', body: { name: 'Other community' }, status: 201 })).id
    const otherChannel = (await request(`/api/workspaces/${other}/channels`, { who: owner, method: 'POST', body: { name: 'private', kind: 'text' }, status: 201 })).id
    await install({ ...cfg, channelIds: [otherChannel] }, 403)
    await install({ ...cfg, endpointUrl: 'https://unapproved.example.com/events', events: ['message.created'] }, 403)
    const bot = await install(), appId = bot.app.id, appPath = `/api/workspaces/main/apps/${appId}`, postPath = `/api/apps/${appId}/messages`
    const saved = await db.prepare('SELECT * FROM server_apps WHERE id = ?').bind(appId).first()
    assert(!JSON.stringify(saved).includes(bot.token)); assert(!JSON.stringify(saved).includes(bot.signingSecret))
    assert.equal(await db.prepare('SELECT count(*) AS n FROM memberships WHERE user_id = ?').bind(saved.bot_user_id).first('n'), 0)
    assert.equal(await db.prepare('SELECT count(*) AS n FROM auth_user WHERE id = ?').bind(saved.bot_user_id).first('n'), 0)
    const body = { id: crypto.randomUUID(), channelId: 'general', text: 'CI build passed' }
    await request(postPath, { method: 'POST', body, who: owner, status: 401 })
    await request('/api/channels/general/messages', { token: bot.token, status: 401 })
    await request('/api/bootstrap', { token: bot.token, status: 401 })
    await request(postPath, { method: 'POST', body: { ...body, channelId: otherChannel }, token: bot.token, status: 403 })
    const message = await request(postPath, { method: 'POST', body, token: bot.token, status: 201 })
    assert.equal(message.bot, true); assert.equal(message.author, 'Build Bot'); assert.equal(message.avatarUrl, cfg.avatarUrl)
    await request('/api/channels/general/threads', { who: owner, method: 'POST', body: { id: crypto.randomUUID(), parentMessageId: message.id, name: 'Human thread metadata' }, status: 201 })
    await request(`/api/channels/general/messages/${message.id}`, { who: owner, method: 'POST', body: { emoji: '👍' } })
    const retry = await request(postPath, { method: 'POST', body, token: bot.token }); assert.equal(retry.id, message.id)
    assert.equal(retry.thread, null); assert.deepEqual(retry.reactions, [], 'Post-only credentials do not receive human metadata on their message')
    await request(postPath, { method: 'POST', body: { ...body, text: 'Different payload' }, token: bot.token, status: 409 })
    const concurrentBody = { ...body, id: crypto.randomUUID() }
    // Both concurrent requests converge on the same message. Status may be 200 or 201.
    const concurrent = await Promise.all(Array.from({ length: 3 }, () => mf.dispatchFetch(base + postPath, { method: 'POST', headers: { Authorization: `Bearer ${bot.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(concurrentBody) }).then(async r => { assert([200, 201].includes(r.status)); return r.json() })))
    assert.equal(new Set(concurrent.map(m => m.id)).size, 1)
    await request(`/api/channels/general/messages/${concurrent[0].id}`, { who: owner, method: 'DELETE' })
    await request(postPath, { method: 'POST', body: concurrentBody, token: bot.token, status: 409 })
    assert.equal(await db.prepare('SELECT count(*) AS n FROM messages WHERE app_id = ? AND app_request_id = ?').bind(appId, concurrentBody.id).first('n'), 0, 'A receipt prevents deleted messages being resurrected')
    await request(`/api/workspaces/${other}/apps/${appId}/rotate`, { who: owner, method: 'POST', status: 404 })
    const rotated = await request(appPath + '/rotate', { who: owner, method: 'POST' })
    await request(postPath, { method: 'POST', body: { ...body, id: crypto.randomUUID() }, token: bot.token, status: 401 })
    await request(postPath, { method: 'POST', body: { ...body, id: crypto.randomUUID() }, token: rotated.token, status: 201 })
    await request(appPath, { who: owner, method: 'PUT', body: { ...cfg, enabled: false } })
    await request(postPath, { method: 'POST', body: { ...body, id: crypto.randomUUID() }, token: rotated.token, status: 403 })
    await request(appPath, { who: owner, method: 'PUT', body: cfg })
    const ping = await install({ ...cfg, name: 'Ping Bot', kind: 'ping' })
    const registry = await request('/api/channels/general/commands', { who: member })
    assert(registry.some(c => c.appId === ping.app.id && c.name === 'ping'))
    const invoke = { id: crypto.randomUUID(), appId: ping.app.id, name: 'ping', arguments: {} }
    await request('/api/channels/general/commands', { who: member, method: 'POST', body: { ...invoke, arguments: { arbitrary: 'input' } }, status: 400 })
    await request(`/api/channels/${otherChannel}/commands`, { who: member, method: 'POST', body: invoke, status: 403 })
    const pong = await request('/api/channels/general/commands', { who: member, method: 'POST', body: invoke })
    assert.equal(pong.status, 'completed'); assert.equal(pong.message.text, 'Pong!'); assert.equal(pong.message.author, 'Ping Bot')
    assert.equal((await request('/api/channels/general/commands', { who: member, method: 'POST', body: invoke })).message.id, pong.message.id)
    await request(`/api/channels/general/commands/${invoke.id}`, { who: owner, status: 404 })
    const eventConfig = { ...cfg, name: 'Event bot', endpointUrl: 'https://hooks.example.com/events', events: ['message.created'] }
    const eventBot = await install(eventConfig); secrets.set('/events', eventBot.signingSecret)
    const human = { id: crypto.randomUUID(), text: 'New human message' }
    await request('/api/channels/general/messages', { who: member, method: 'POST', body: human, status: 201 })
    assert.equal(deliveries.length, 1); assert.equal(deliveries[0].data.messageId, human.id)
    assert.deepEqual(Object.keys(deliveries[0].data).sort(), ['authorId', 'channelId', 'messageId', 'text', 'threadId', 'workspaceId'])
    const eventId = deliveries[0].id
    await db.prepare("UPDATE app_outbox SET status = 'sending', due_at = 0 WHERE id = ?").bind(eventId).run()
    await Promise.all([request('/_test/flush'), request('/_test/flush')])
    assert.equal(deliveries.length, 2); assert.equal(effects.size, 1, 'Receiver deduplicates repeat delivery by stable event ID')
    await request(`/api/channels/${otherChannel}/messages`, { who: owner, method: 'POST', body: { id: crypto.randomUUID(), text: 'Never exported' }, status: 201 })
    await request(`/api/apps/${eventBot.app.id}/messages`, { method: 'POST', token: eventBot.token, body: { id: crypto.randomUUID(), channelId: 'general', text: 'Bot event must not recurse @member' }, status: 201 })
    await request('/_test/flush'); assert.equal(deliveries.length, 2)
    const echoConfig = { ...cfg, name: 'Echo', endpointUrl: 'https://hooks.example.com/commands', commands: [{ name: 'hello', description: 'Say hello', arguments: [{ name: 'name', type: 'string', required: true }] }] }
    const echo = await install(echoConfig); secrets.set('/commands', echo.signingSecret)
    const hello = { id: crypto.randomUUID(), appId: echo.app.id, name: 'hello', arguments: { name: 'World' } }
    const pending = await request('/api/channels/general/commands', { who: member, method: 'POST', body: hello }); assert.equal(pending.status, 'pending')
    const completed = await request(`/api/channels/general/commands/${hello.id}`, { who: member })
    assert.equal(completed.status, 'completed'); assert.equal(completed.message.text, 'Hello World')
    const count = deliveries.length
    await request('/api/channels/general/commands', { who: member, method: 'POST', body: hello }); assert.equal(deliveries.length, count)
    await request('/api/channels/general/commands', { who: member, method: 'POST', body: { ...hello, arguments: { name: 'Changed' } }, status: 409 })
    // Rotate while the provider is responding: a cancelled in-flight event cannot post.
    let release, seen
    const reachedProvider = new Promise(resolve => { seen = resolve })
    gate = { seen, wait: new Promise(resolve => { release = resolve }) }
    const inFlight = { ...hello, id: crypto.randomUUID() }
    const running = request('/api/channels/general/commands', { who: member, method: 'POST', body: inFlight })
    await reachedProvider
    const changed = await request(`/api/workspaces/main/apps/${echo.app.id}/rotate`, { who: owner, method: 'POST' })
    release(); gate = null; await running
    secrets.set('/commands', changed.signingSecret)
    assert.equal((await request(`/api/channels/general/commands/${inFlight.id}`, { who: member })).status, 'cancelled')
    assert.equal(await db.prepare('SELECT count(*) AS n FROM app_message_requests WHERE app_id = ? AND request_id = ?').bind(echo.app.id, `command:${inFlight.id}`).first('n'), 0)
    // Role and app features together: read-only members cannot use commands;
    // revoking permissions while a provider responds prevents a late bot reply.
    let releasePermission, permissionSeen
    const permissionReached = new Promise(resolve => { permissionSeen = resolve })
    gate = { seen: permissionSeen, wait: new Promise(resolve => { releasePermission = resolve }) }
    const revokedCommand = { ...hello, id: crypto.randomUUID() }
    const permissionFlight = request('/api/channels/general/commands', { who: member, method: 'POST', body: revokedCommand })
    await permissionReached
    const permissionPath = '/api/channels/general/permissions'
    const deny = permission => ({ subjectType: 'member', subjectId: memberUser.id, permission, effect: 'deny' })
    await request(permissionPath, { who: owner, method: 'PUT', body: { overrides: [deny('messages.send')] } })
    releasePermission(); gate = null; await permissionFlight
    assert.equal((await request(`/api/channels/general/commands/${revokedCommand.id}`, { who: member })).status, 'cancelled')
    assert.equal(await db.prepare('SELECT count(*) AS n FROM app_message_requests WHERE app_id=? AND request_id=?').bind(echo.app.id, `command:${revokedCommand.id}`).first('n'), 0)
    await request('/api/channels/general/commands', { who: member, status: 403 })
    await request('/api/channels/general/commands', { who: member, method: 'POST', body: { ...hello, id: crypto.randomUUID() }, status: 403 })
    await request(permissionPath, { who: owner, method: 'PUT', body: { overrides: [deny('messages.read')] } })
    await request(`/api/channels/general/commands/${hello.id}`, { who: member, status: 403 })
    await request('/api/channels/general/commands', { who: member, method: 'POST', body: { ...hello, id: crypto.randomUUID() }, status: 403 })
    await request(permissionPath, { who: owner, method: 'PUT', body: { overrides: [deny('channels.view')] } })
    await request('/api/channels/general/commands', { who: member, status: 403 })
    await request(permissionPath, { who: owner, method: 'PUT', body: { overrides: [] } })
    failure = 503
    const failedCommand = { ...hello, id: crypto.randomUUID() }
    await request('/api/channels/general/commands', { who: member, method: 'POST', body: failedCommand })
    for (let i = 0; i < 4; i++) { await db.prepare('UPDATE app_outbox SET due_at = 0 WHERE id = ?').bind(failedCommand.id).run(); await request('/_test/flush') }
    assert.equal((await request(`/api/channels/general/commands/${failedCommand.id}`, { who: member })).status, 'failed')
    assert.equal(await db.prepare('SELECT attempts FROM app_outbox WHERE id = ?').bind(failedCommand.id).first('attempts'), 5)
    const removedMember = { ...hello, id: crypto.randomUUID() }
    await request('/api/channels/general/commands', { who: member, method: 'POST', body: removedMember })
    await request(`/api/workspaces/main/members/${memberUser.id}`, { who: owner, method: 'DELETE' })
    await db.prepare('UPDATE app_outbox SET due_at = 0 WHERE id = ?').bind(removedMember.id).run()
    failure = 0
    const beforeRemoved = deliveries.length; await request('/_test/flush'); assert.equal(deliveries.length, beforeRemoved)
    assert.equal(await db.prepare('SELECT status FROM app_invocations WHERE id = ?').bind(removedMember.id).first('status'), 'cancelled')
    // Revoking an outbound origin blocks credentials, not just the event dispatcher.
    await request('/api/installation/apps', { who: owner, method: 'PUT', body: { enabled: true, allowedOrigins: [] } })
    await request(`/api/apps/${eventBot.app.id}/messages`, { method: 'POST', token: eventBot.token, body: { ...body, id: crypto.randomUUID() }, status: 403 })
    await request('/api/installation/apps', { who: owner, method: 'PUT', body: { ...policy, enabled: false } })
    await request(postPath, { method: 'POST', token: rotated.token, body: { ...body, id: crypto.randomUUID() }, status: 403 })
    assert.equal((await request('/api/channels/general/commands', { who: owner })).length, 0)
    await request('/api/installation/apps', { who: owner, method: 'PUT', body: policy })
    const limited = await install({ ...cfg, name: 'Rate limited' })
    for (let i = 0; i < 30; i++) await request(`/api/apps/${limited.app.id}/messages`, { method: 'POST', token: limited.token, body: { ...body, id: crypto.randomUUID() }, status: 201 })
    await request(`/api/apps/${limited.app.id}/messages`, { method: 'POST', token: limited.token, body: { ...body, id: crypto.randomUUID() }, status: 429 })
    await request(appPath, { who: owner, method: 'DELETE' })
    await request(postPath, { method: 'POST', token: rotated.token, body, status: 404 })
    const history = await request('/api/channels/general/messages', { who: owner })
    assert(history.some(m => m.id === message.id && m.author === 'Build Bot' && m.bot), 'Uninstall preserves historical bot identity')
    const activities = await request('/api/workspaces/main/apps-audit', { who: owner })
    for (const action of ['app.installed', 'credentials.rotated', 'app.disabled', 'app.uninstalled', 'message.posted', 'delivery.failed']) assert(activities.some(a => a.action === action), action)
    assert(!JSON.stringify(activities).includes(rotated.token))
    await slackWebhookChecks({ mf, db, base, request, owner, member, cfg, other, otherChannel, engine })
    console.log(`PASS ${engine}: app policy, channel/server isolation, bot identity, scoped credentials, concurrent deduplication, revocation, command validation/results, signatures, leased retries, receiver idempotency, recursion prevention, rate limits and audit`)
    await mf.dispose(); mf = null
  }
} finally { await mf?.dispose(); await rm(dir, { recursive: true, force: true }) }

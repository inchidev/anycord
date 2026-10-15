import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash, createHmac } from 'node:crypto'

const dir = await mkdtemp(join(tmpdir(), 'anycord-telegram-'))
const base = 'https://anycord.test', issuer = 'https://oauth.telegram.org'
const token = '12345:local-test-token-never-send-to-telegram', secret = 'local-test-oidc-secret'
const { privateKey, publicKey } = await generateKeyPair('RS256')
const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' }
const flows = new Map(), deliveries = []
let webhookSecret = '', deliveryFailure = 0, mf
const response = (body, status = 200) => Response.json(body, { status })
const provider = async request => {
  const url = new URL(request.url)
  if (url.origin === issuer) {
    if (url.pathname === '/.well-known/openid-configuration') return response({ issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/.well-known/jwks.json`, id_token_signing_alg_values_supported: ['RS256'] })
    if (url.pathname === '/.well-known/jwks.json') return response({ keys: [jwk] })
    if (url.pathname === '/token') {
      assert.equal(request.headers.get('Authorization'), `Basic ${Buffer.from(`12345:${secret}`).toString('base64')}`)
      const input = new URLSearchParams(await request.text()), flow = flows.get(input.get('code'))
      assert(flow, 'Only a code from the test authorization server may be redeemed')
      assert.equal(createHash('sha256').update(input.get('code_verifier')).digest('base64url'), flow.challenge)
      const payload = { id: flow.id, name: 'Telegram member', picture: 'https://cdn4.telesco.pe/file/test-avatar.jpg', nonce: flow.nonce }
      if (flow.badNonce) payload.nonce = 'wrong-nonce'
      const jwt = await new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(flow.badIssuer ? 'https://attacker.test' : issuer).setAudience(flow.badAudience ? 'wrong-client' : '12345')
        .setSubject(`opaque-sub-${flow.id}`).setIssuedAt().setExpirationTime(flow.expired ? '-1m' : '5m').sign(privateKey)
      return response({ access_token: 'test-access', token_type: 'Bearer', expires_in: 300, id_token: flow.badSignature ? jwt.slice(0, -12) + 'AAAAAAAAAAAA' : jwt })
    }
  }
  if (url.origin === 'https://api.telegram.org') {
    assert(url.pathname.startsWith(`/bot${token}/`))
    const body = await request.json()
    if (url.pathname.endsWith('/getMe')) return response({ ok: true, result: { id: 12345, username: 'anycord_test_bot', is_bot: true } })
    if (url.pathname.endsWith('/setWebhook')) { webhookSecret = body.secret_token; return response({ ok: true, result: true }) }
    if (url.pathname.endsWith('/sendMessage')) {
      if (deliveryFailure) return response({ ok: false, parameters: { retry_after: 1 } }, deliveryFailure)
      deliveries.push(body); return response({ ok: true, result: { message_id: deliveries.length } })
    }
  }
  throw new Error(`Unexpected external request: ${url.origin}${url.pathname}`)
}
const actor = () => ({ cookies: new Map() })
let requestCount = 0
async function request(path, { who = actor(), method = 'GET', body, status = 200, headers = {} } = {}) {
  const result = await mf.dispatchFetch(base + path, { method, redirect: 'manual', headers: {
    ...(method === 'GET' ? {} : { Origin: base }), 'Content-Type': 'application/json',
    'CF-Connecting-IP': `192.0.2.${(++requestCount % 240) + 1}`, cookie: [...who.cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...headers,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  for (const cookie of result.headers.getSetCookie()) {
    const [pair] = cookie.split(';'), index = pair.indexOf('=')
    who.cookies.set(pair.slice(0, index), pair.slice(index + 1))
  }
  const raw = await result.text()
  assert.equal(result.status, status, `${method} ${path}: ${raw.slice(0, 500)}`)
  return { data: raw ? JSON.parse(raw) : null, headers: result.headers, who }
}
function initData(id, extra = {}, timestamp = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({ auth_date: String(timestamp), query_id: crypto.randomUUID(), user: JSON.stringify({ id, first_name: 'Telegram member', photo_url: 'https://cdn4.telesco.pe/file/test-avatar.jpg' }), ...extra })
  const check = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n')
  const key = createHmac('sha256', 'WebAppData').update(token).digest()
  params.set('hash', createHmac('sha256', key).update(check).digest('hex'))
  return params.toString()
}
async function oauth(who, id, { link = false, badState = false, expectedError = false, ...errors } = {}) {
  const start = await request(link ? '/api/auth/link-social' : '/api/auth/sign-in/social', { who, method: 'POST', body: { provider: 'telegram', callbackURL: '/main/general?thread=abc#message-preserved' } })
  const authorization = new URL(start.data.url), code = crypto.randomUUID()
  assert.equal(authorization.origin, issuer)
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
  assert(!authorization.searchParams.get('scope').includes('phone'))
  flows.set(code, { id, nonce: authorization.searchParams.get('nonce'), challenge: authorization.searchParams.get('code_challenge'), ...errors })
  const callback = await request(`/api/auth/callback/telegram?code=${code}&state=${badState ? 'invalid-state' : authorization.searchParams.get('state')}`, { who, status: 302, headers: { 'Sec-Fetch-Site': 'cross-site' } })
  const destination = callback.headers.get('location')
  if (expectedError || badState || Object.keys(errors).length) assert(destination.includes('error='), destination)
  else assert.equal(destination, `${base}/main/general?thread=abc#message-preserved`)
  return callback
}

try {
  const passwordFallback = fileURLToPath(new URL('./password.mjs', import.meta.resolve('@better-auth/utils/password')))
  await build({ stdin: { contents: `import handler from './worker/cloudflare'; export { WorkspaceHub, ChatRoom } from './worker/cloudflare'; import { flushTelegramNotifications } from './worker/telegram-notifications'; export default { ...handler, async fetch(request, env, ctx) { if (new URL(request.url).pathname === '/_test/flush') { await flushTelegramNotifications(env); return Response.json({ok:true}) } const pending = []; const result = await handler.fetch(request, env, { waitUntil: promise => pending.push(promise) }); await Promise.all(pending); return result } }`, resolveDir: process.cwd(), loader: 'ts' },
    outfile: join(dir, 'worker.mjs'), bundle: true, format: 'esm', target: 'es2022', conditions: ['workerd', 'worker', 'browser'], alias: { '@better-auth/utils/password': passwordFallback }, external: ['cloudflare:*', 'node:*'] })
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, modulesRoot: dir, scriptPath: join(dir, 'worker.mjs'), compatibilityDate: '2026-10-14', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], durableObjects: { HUBS: { className: 'WorkspaceHub', useSQLite: true }, ROOMS: { className: 'ChatRoom', useSQLite: true } }, cf: false,
    bindings: { AUTH_BASE_URL: base, APP_SECRET: crypto.randomUUID(), MIGRATION_TOKEN: 'test-migration', SETUP_TOKEN: 'test-setup' }, serviceBindings: { ASSETS: () => new Response('<!doctype html><title>Anycord</title>', { headers: { 'Content-Type': 'text/html' } }) }, outboundService: provider }))
  await mf.ready
  const db = await mf.getD1Database('DB')
  await request('/api/_migrate', { method: 'POST', body: {}, headers: { 'X-Migration-Token': 'test-migration' } })
  await request('/api/auth/telegram/miniapp', { method: 'POST', body: { initData: initData(42) }, status: 403 })
  const owner = actor(), member = actor()
  const credentials = { name: 'owner', password: 'correct-horse-battery', setupCode: 'test-setup' }
  await request('/api/auth/register', { method: 'POST', body: { ...credentials, setupCode: '' }, status: 403 })
  const first = await request('/api/auth/register', { who: owner, method: 'POST', body: credentials, status: 201 })
  assert.equal(first.data.user.role, 'owner'); assert.equal(first.data.user.name, 'owner')
  assert(first.headers.getSetCookie().some(cookie => /SameSite=None/i.test(cookie) && /Partitioned/i.test(cookie)))
  await request('/api/auth/register', { who: member, method: 'POST', body: { name: 'member', password: credentials.password }, status: 201 })
  for (const path of ['/api/installation/authentication', '/api/integrations/telegram']) await request(path, { who: member, status: 403 })
  await request('/api/auth/sign-up/email', { method: 'POST', body: { email: 'bypass@test.invalid', password: credentials.password, name: 'bypass' }, status: 404 })
  await request('/api/integrations/telegram', { who: owner, method: 'PUT', body: { botToken: token, clientId: '12345', clientSecret: secret, notifications: true } })
  const saved = await db.prepare("SELECT value FROM settings WHERE key = 'authentication'").first()
  assert(!saved.value.includes(token)); assert(!saved.value.includes(secret))
  await request('/api/installation/authentication', { who: owner, method: 'PUT', body: { passwordLogin: false, registration: true, telegramLogin: true, miniAppLogin: true }, status: 409 })
  const policy = { passwordLogin: true, registration: true, telegramLogin: true, miniAppLogin: true }
  await request('/api/installation/authentication', { who: owner, method: 'PUT', body: policy })
  const embedded = await mf.dispatchFetch(base + '/login')
  assert(!embedded.headers.has('X-Frame-Options')); assert.equal(embedded.headers.get('Content-Security-Policy'), "frame-ancestors 'self' https://web.telegram.org")
  const browser = actor()
  await oauth(browser, 42)
  const browserUser = (await request('/api/auth/status', { who: browser })).data.user
  assert(browserUser); assert.notEqual(browserUser.id, '42')
  assert.equal(browserUser.name, 'Telegram member'); assert.equal(browserUser.telegram, true)
  assert.equal(browserUser.avatarUrl, 'https://cdn4.telesco.pe/file/test-avatar.jpg')
  const mini = actor()
  await request('/api/auth/telegram/miniapp', { who: mini, method: 'POST', body: { initData: initData(42) } })
  assert.equal((await request('/api/auth/status', { who: mini })).data.user.id, browserUser.id)
  assert.equal((await db.prepare("SELECT account_id FROM auth_account WHERE user_id = ? AND provider_id = 'telegram'").bind(browserUser.id).first()).account_id, '42')
  const oldHandle = await db.prepare('SELECT name FROM users WHERE id = ?').bind(browserUser.id).first('name')
  await db.prepare('UPDATE auth_user SET name = ? WHERE id = ?').bind('Telegram member · tg:42', browserUser.id).run()
  assert.equal((await request('/api/auth/status', { who: mini })).data.user.name, 'Telegram member', 'legacy suffix is removed without changing the unique account handle')
  const sessionsBeforeProfile = await db.prepare('SELECT count(*) AS n FROM auth_session').first('n')
  const refreshedProfile = initData(42, { user: JSON.stringify({ id: 42, first_name: 'Иван', last_name: 'Мотовилов', photo_url: 'https://t.me/i/userpic/320/test-avatar.jpg' }) })
  await request('/api/account/telegram/profile', { method: 'POST', body: { initData: refreshedProfile }, status: 401 })
  const refreshed = (await request('/api/account/telegram/profile', { who: mini, method: 'POST', body: { initData: refreshedProfile } })).data
  assert.equal(refreshed.name, 'Иван Мотовилов'); assert.equal(refreshed.avatarUrl, 'https://t.me/i/userpic/320/test-avatar.jpg')
  const profileMember = (await request('/api/bootstrap?workspace=main', { who: mini })).data.members.find(user => user.id === browserUser.id)
  assert.equal(profileMember.name, refreshed.name); assert.equal(profileMember.avatarUrl, refreshed.avatarUrl)
  assert.equal(await db.prepare('SELECT name FROM users WHERE id = ?').bind(browserUser.id).first('name'), oldHandle)
  assert.equal(await db.prepare('SELECT count(*) AS n FROM auth_session').first('n'), sessionsBeforeProfile, 'profile sync must not create a login session')
  await request('/api/account/telegram/profile', { who: mini, method: 'POST', body: { initData: initData(43) }, status: 403 })
  await request('/api/account/telegram/profile', { who: mini, method: 'POST', body: { initData: refreshedProfile.replace('test-avatar', 'forged-avatar') }, status: 401 })
  await oauth(actor(), 42, { badNonce: true })
  assert.equal((await request('/api/auth/status', { who: mini })).data.user.name, 'Иван Мотовилов', 'unverified or mismatched provider data must not overwrite a profile')
  for (const malformed of [initData(42).replace('Telegram', 'Forged'), initData(42, {}, Math.floor(Date.now() / 1000) - 600), initData(42) + '&auth_date=1', initData(42, {}, Math.floor(Date.now() / 1000) + 120)]) {
    await request('/api/auth/telegram/miniapp', { method: 'POST', body: { initData: malformed }, status: 401 })
  }
  await request('/api/auth/telegram/miniapp', { who: owner, method: 'POST', body: { initData: initData(42) }, status: 409 })
  await oauth(owner, 43, { link: true })
  const ownerMini = actor()
  await request('/api/auth/telegram/miniapp', { who: ownerMini, method: 'POST', body: { initData: initData(43) } })
  assert.equal((await request('/api/auth/status', { who: ownerMini })).data.user.id, first.data.user.id)
  assert.equal((await request('/api/auth/status', { who: ownerMini })).data.user.name, 'owner', 'linking Telegram keeps an existing password account name')
  await request('/api/auth/sign-in/social', { who: owner, method: 'POST', body: { provider: 'telegram' }, status: 409 })
  await request('/api/auth/telegram/miniapp', { who: member, method: 'POST', body: { initData: initData(44), link: true } })
  const miniFirst = actor()
  await request('/api/auth/telegram/miniapp', { who: miniFirst, method: 'POST', body: { initData: initData(45) } })
  const miniFirstUser = (await request('/api/auth/status', { who: miniFirst })).data.user
  assert.equal(miniFirstUser.name, browserUser.name); assert.notEqual(miniFirstUser.id, browserUser.id, 'same display name is not the same account')
  const invalidAvatar = actor()
  await request('/api/auth/telegram/miniapp', { who: invalidAvatar, method: 'POST', body: { initData: initData(46, { user: JSON.stringify({ id: 46, first_name: 'Telegram member', photo_url: 'javascript:alert(1)' }) }) } })
  assert.equal((await request('/api/auth/status', { who: invalidAvatar })).data.user.avatarUrl, null)
  await db.prepare('UPDATE auth_session SET created_at = ? WHERE user_id = ?').bind(Date.now() - 1200_000, miniFirstUser.id).run()
  await request('/api/account/password', { who: miniFirst, method: 'POST', body: { username: 'stale_session', password: credentials.password }, status: 403 })
  assert.equal(await db.prepare('SELECT username FROM auth_user WHERE id = ?').bind(miniFirstUser.id).first('username'), null)
  const browserSecond = actor(); await oauth(browserSecond, 45)
  assert.equal((await request('/api/auth/status', { who: browserSecond })).data.user.id, miniFirstUser.id)
  for (const errors of [{ badState: true }, { badNonce: true }, { badIssuer: true }, { badAudience: true }, { badSignature: true }, { expired: true }]) await oauth(actor(), 999, errors)
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM auth_account WHERE provider_id = 'telegram' AND account_id = '999'").first('n'), 0)
  await request('/api/installation/authentication', { who: owner, method: 'PUT', body: { ...policy, registration: false } })
  await request('/api/auth/register', { method: 'POST', body: { name: 'closed', password: credentials.password }, status: 403 })
  await request('/api/auth/telegram/miniapp', { method: 'POST', body: { initData: initData(1000) }, status: 403 })
  await oauth(actor(), 1000, { expectedError: true })
  await oauth(actor(), 42)
  await request('/api/installation/authentication', { who: owner, method: 'PUT', body: { ...policy, passwordLogin: false } })
  await request('/api/auth/login', { method: 'POST', body: credentials, status: 403 })
  await request('/api/auth/sign-in/username', { method: 'POST', body: { username: 'owner', password: credentials.password }, status: 403 })
  await request('/api/connections/login', { method: 'POST', body: credentials, status: 403 })
  await request('/api/account/telegram', { who: owner, method: 'DELETE', status: 409 })
  await request('/api/installation/authentication', { who: owner, method: 'PUT', body: policy })
  await request('/api/account/password', { who: browser, method: 'POST', body: { username: 'telegram_member', password: credentials.password } })
  const passwordLogin = await request('/api/auth/login', { method: 'POST', body: { name: 'telegram_member', password: credentials.password } })
  assert.equal(passwordLogin.data.user.id, browserUser.id)

  await request('/api/integrations/telegram/webhook', { who: owner, method: 'POST' })
  const webhook = { message: { text: '/start notifications', from: { id: 42 }, chat: { id: 42, type: 'private' } } }
  await request('/api/telegram/webhook', { method: 'POST', body: webhook, status: 403 })
  await request('/api/telegram/webhook', { method: 'POST', body: webhook, headers: { 'X-Telegram-Bot-Api-Secret-Token': webhookSecret } })
  const prefs = { enabled: true, preview: false, mutedChannelIds: [] }
  await request('/api/account/telegram', { who: browser, method: 'PUT', body: prefs })
  await request('/api/account/telegram/test', { who: browser, method: 'POST' })
  assert.equal(deliveries.pop().chat_id, '42')
  await request('/api/channels/general/messages', { who: owner, method: 'POST', body: { id: crypto.randomUUID(), text: '@telegram_member an explicit mention' }, status: 201 })
  await request('/_test/flush'); assert.equal(deliveries.length, 1); deliveries.length = 0
  const root = await request('/api/channels/general/messages', { who: browser, method: 'POST', body: { id: crypto.randomUUID(), text: 'A message to reply to' }, status: 201 })
  assert.equal(root.data.author, 'Telegram member'); assert.equal(root.data.avatarUrl, 'https://cdn4.telesco.pe/file/test-avatar.jpg')
  const search = (await request('/api/search?workspace=main&q=A%20message%20to%20reply', { who: browser })).data
  assert.equal(search.find(message => message.id === root.data.id).author, 'Telegram member')
  const reply = { id: crypto.randomUUID(), text: 'A private reply preview', replyToId: root.data.id }
  await request('/api/channels/general/messages', { who: owner, method: 'POST', body: reply, status: 201 })
  await request('/_test/flush')
  assert.equal(deliveries.length, 1); assert(!deliveries[0].text.includes(reply.text)); assert(deliveries[0].text.includes(`#message-${reply.id}`))
  await request('/api/channels/general/messages', { who: owner, method: 'POST', body: reply })
  await request('/_test/flush'); assert.equal(deliveries.length, 1, 'Retrying a message must not alert twice')
  await request('/api/account/telegram', { who: browser, method: 'PUT', body: { ...prefs, mutedChannelIds: ['general'] } })
  await request('/api/channels/general/messages', { who: owner, method: 'POST', body: { ...reply, id: crypto.randomUUID() }, status: 201 })
  await request('/_test/flush'); assert.equal(deliveries.length, 1, 'Muted channel must stay quiet')
  await request('/api/account/telegram', { who: browser, method: 'PUT', body: { ...prefs, preview: true } })
  const thread = await request('/api/channels/general/threads', { who: owner, method: 'POST', body: { id: crypto.randomUUID(), parentMessageId: root.data.id, name: 'Followed thread' }, status: 201 })
  await request(`/api/channels/general/threads/${thread.data.id}/follow`, { who: browser, method: 'PUT', body: { following: true } })
  await request('/api/channels/general/messages', { who: owner, method: 'POST', body: { id: crypto.randomUUID(), text: 'Followed thread activity', threadId: thread.data.id }, status: 201 })
  await request('/_test/flush'); assert.equal(deliveries.length, 2); assert(deliveries[1].text.includes('Followed thread activity')); assert(deliveries[1].text.includes(`thread=${thread.data.id}`))
  // A private channel must not send mention/reply previews to unauthorized members.
  await request('/api/channels/general/permissions', { who: owner, method: 'PUT', body: { overrides: [{ subjectType: 'member', subjectId: browserUser.id, permission: 'channels.view', effect: 'deny' }] } })
  await request('/api/channels/general/messages', { who: owner, method: 'POST', body: { ...reply, id: crypto.randomUUID() }, status: 201 })
  await request('/_test/flush'); assert.equal(deliveries.length, 2, 'Private channel access must be checked before delivering a reply notification')
  await request('/api/channels/general/permissions', { who: owner, method: 'PUT', body: { overrides: [] } })
  // A definite Telegram rejection retries with a bound; access is checked again.
  deliveryFailure = 429
  const retryMessage = { ...reply, id: crypto.randomUUID() }
  await request('/api/channels/general/messages', { who: owner, method: 'POST', body: retryMessage, status: 201 })
  await request('/_test/flush')
  await db.prepare("UPDATE telegram_outbox SET due_at = 0 WHERE message_id = ?").bind(retryMessage.id).run()
  await request('/api/channels/general/permissions', { who: owner, method: 'PUT', body: { overrides: [{ subjectType: 'member', subjectId: browserUser.id, permission: 'messages.read', effect: 'deny' }] } })
  deliveryFailure = 0
  await request('/_test/flush'); assert.equal(deliveries.length, 2, 'Permission revocation must stop already queued delivery')
  await request(`/api/workspaces/main/bans/${browserUser.id}`, { who: owner, method: 'POST' })
  deliveryFailure = 0
  await request('/_test/flush'); assert.equal(deliveries.length, 2, 'Revoked membership must stop queued delivery')
  await request('/api/account/telegram', { who: browser, method: 'DELETE' })
  assert.equal((await request('/api/account/telegram', { who: browser })).data.linked, false)
  const unlinked = (await request('/api/auth/status', { who: browser })).data.user
  assert.equal(unlinked.name, 'Telegram member'); assert.equal(unlinked.telegram, false); assert.equal(unlinked.avatarUrl, 'https://cdn4.telesco.pe/file/test-avatar.jpg')
  await request('/api/account/telegram/test', { who: browser, method: 'POST', status: 409 })
  console.log('PASS: real Worker/D1 Better Auth sessions; OIDC PKCE/JWKS/nonce/claim validation; Mini App signatures; identity convergence/linking; setup/admission/owner recovery; encrypted settings; webhook consent; reply/follow/mute/dedup/retry/access revocation.')
} finally { try { await mf?.dispose() } finally { await rm(dir, { recursive: true, force: true }) } }

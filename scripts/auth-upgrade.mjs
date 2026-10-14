import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'

if (!process.env.LEGACY_WORKER_FILE) throw new Error('Provide the previous built Worker in LEGACY_WORKER_FILE')
const folder = await mkdtemp(join(tmpdir(), 'cellcord-auth-upgrade-'))
const base = 'http://127.0.0.1:19878', token = crypto.randomUUID()
let child, logs = '', ws
await mkdir(join(folder, '.output'), { recursive: true })
await cp('.output/public', join(folder, '.output/public'), { recursive: true })
await cp('wrangler.jsonc', join(folder, 'wrangler.jsonc'))
await cp(process.env.LEGACY_WORKER_FILE, join(folder, 'worker.js'))
await writeFile(join(folder, '.dev.vars'), `APP_SECRET=${crypto.randomUUID()}\nMIGRATION_TOKEN=${token}\nAUTH_BASE_URL=${base}\n`)
async function start() {
  child = spawn('celld', ['dev', '.', '--host', '127.0.0.1', '--port', '19878', '--no-watch'], { cwd: folder })
  child.stdout.on('data', (value) => { logs += value }); child.stderr.on('data', (value) => { logs += value })
  for (let i = 0; i < 160; i++) { try { if ((await fetch(`${base}/api/_runtime`)).ok) return } catch {} await delay(250) }
  throw new Error('Upgrade test runtime did not start')
}
async function stop() {
  if (!child || child.exitCode !== null) return
  const current = child, exited = once(child, 'exit'), controller = new AbortController()
  current.kill('SIGINT')
  await Promise.race([exited, delay(20_000, undefined, { signal: controller.signal }).then(() => current.kill('SIGKILL')).catch(() => undefined)])
  controller.abort(); if (current.exitCode === null && current.signalCode === null) await exited
}
async function api(path, { cookie, method = 'GET', body, expected = 200, migration = false } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(migration ? { 'X-Migration-Token': token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined })
  const data = await response.json()
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`)
  const cookies = response.headers.getSetCookie().filter((value) => !value.includes('Max-Age=0')).map((value) => value.split(';')[0]).join('; ')
  return { data, cookie: cookies }
}
try {
  await start()
  await api('/api/_migrate', { method: 'POST', body: {}, migration: true })
  const old = await api('/api/auth/register', { method: 'POST', body: { name: 'upgrade-user', password: 'same-password-after-upgrade' }, expected: 201 })
  const id = crypto.randomUUID()
  await api('/api/channels/general/messages', { cookie: old.cookie, method: 'POST', body: { id, text: 'Keep my identity and this message' }, expected: 201 })
  await stop()
  await cp(process.env.TEST_WORKER_FILE || 'worker.js', join(folder, 'worker.js'))
  await start()
  const migrated = await api('/api/_migrate', { method: 'POST', body: {}, migration: true })
  assert.equal(migrated.data.applied.length, 2); assert(migrated.data.applied[0].startsWith('0002_')); assert(migrated.data.applied[1].startsWith('0003_'))
  const exchanged = await api('/api/auth/status', { cookie: old.cookie })
  assert.equal(exchanged.data.user.id, old.data.user.id); assert.equal(exchanged.data.user.role, 'owner')
  assert(exchanged.cookie.includes('cellcord.session_token='))
  await api('/api/bootstrap', { cookie: old.cookie, expected: 401 })
  const history = await api('/api/channels/general/messages', { cookie: exchanged.cookie })
  assert.equal(history.data.find((message) => message.id === id).authorId, old.data.user.id)
  const login = await api('/api/auth/sign-in/username', { method: 'POST', body: { username: 'upgrade-user', password: 'same-password-after-upgrade' } })
  assert.equal(login.data.user.id, old.data.user.id)
  await api('/api/auth/sign-up/email', { method: 'POST', body: { email: 'bypass@example.com', name: 'bypass', password: 'test-password-value' }, expected: 404 })
  const bootstrap = await api('/api/bootstrap', { cookie: login.cookie }); assert.equal(bootstrap.data.user.role, 'owner')
  ws = new WebSocket(`${base.replace('http', 'ws')}/api/workspaces/main/ws`, { headers: { Cookie: login.cookie, Origin: base } })
  await once(ws, 'open')
  const closed = once(ws, 'close')
  await api('/api/auth/sign-out', { cookie: login.cookie, method: 'POST', body: {} })
  await api('/api/bootstrap', { cookie: login.cookie, expected: 401 })
  const [code] = await Promise.race([closed, delay(5000).then(() => { throw new Error('Sign-out did not revoke the live socket') })])
  assert.equal(code, 4001)
  await api('/api/bootstrap', { cookie: login.cookie, expected: 401 })
  console.log('PASS: upgrade from the previous Worker preserves account ID, password, owner role, message authorship, and membership; legacy cookie exchanges once; Better Auth username sign-in and sign-out/socket revocation work; raw email signup is blocked.')
} catch (error) { console.error(logs.slice(-4000)); throw error }
finally { ws?.terminate(); await stop(); await rm(folder, { recursive: true, force: true }) }

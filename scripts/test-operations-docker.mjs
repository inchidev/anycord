// Explicit local drill: isolated Compose project, state volumes and RustFS.
// Uses prebuilt release fixtures, never existing containers or public accounts.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { AwsClient } from 'aws4fetch'
import WebSocket from 'ws'
import { operationClient, createBackup, restoreBackup, verifyInstallation, runCommand } from '../operations/core.mjs'
import { activateCelld } from '../operations/activate.mjs'

const root = await mkdtemp(join(tmpdir(), 'anycord-docker-drill-'))
const project = 'anycord-drill-' + randomBytes(5).toString('hex')
const context = process.env.ANYCORD_TEST_DOCKER_CONTEXT
const docker = ['docker', ...(context ? ['--context', context] : [])]
const composeFile = join(root, 'compose.json'), compose = [...docker, 'compose', '-f', composeFile, '-p', project]
const oldBuild = JSON.parse(await readFile('shared/build-info.json', 'utf8')), parts = oldBuild.version.split('.').map(Number); parts[2]++
const nextBuild = { ...oldBuild, version: parts.join('.'), commit: '4'.repeat(40) }
const baseImage = `anycord-drill:${project}`, updatedImage = `anycord:${nextBuild.version}-${nextBuild.commit.slice(0, 12)}`
const access = 'drill' + randomBytes(8).toString('hex'), secret = randomBytes(32).toString('hex')
const sourceOrigin = 'http://127.0.0.1:19981', targetOrigin = 'http://127.0.0.1:19982'
let clients = []
async function ready(origin) { for (let i = 0; i < 120; i++) { try { const r = await fetch(origin + '/api/health'); if (r.ok) return } catch {} await delay(500) } throw new Error('Disposable installation did not become healthy') }
async function token(service) { return (await runCommand([...compose, 'exec', '-T', service, 'cat', '/app/.celld/migration-token'])).stdout.trim() }
async function app(origin, path, { cookie, method = 'GET', body, raw = false, expected = 200 } = {}) {
  const response = await fetch(origin + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }) }, ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }) })
  const bytes = new Uint8Array(await response.arrayBuffer()), data = raw ? bytes : JSON.parse(new TextDecoder().decode(bytes))
  assert.equal(response.status, expected, `${method} ${path}: ${raw ? 'binary' : JSON.stringify(data)}`)
  return { data, cookie: response.headers.getSetCookie().find(c => c.includes('cellcord.session_token='))?.split(';')[0] }
}
async function connect(origin, cookie) {
  const ws = new WebSocket(origin.replace('http', 'ws') + '/api/workspaces/main/ws', { headers: { Cookie: cookie, Origin: origin } }), events = []; clients.push(ws)
  ws.on('message', raw => events.push(JSON.parse(raw))); ws.on('error', () => {})
  async function until(predicate) { for (let i = 0; i < 200; i++) { const found = events.find(predicate); if (found) return found; await delay(25) } throw new Error('Expected realtime event did not arrive') }
  await until(e => e.type === 'ready'); return { ws, until }
}
try {
  const packageDir = join(root, 'release'), nextDir = join(root, 'next'); await mkdir(packageDir)
  // Packaging is validated separately; these are disposable version fixtures.
  for (const [from, to] of [['.output/public', '.output/public'], ['runtime/worker.js', 'worker.js'], ['runtime/wrangler.jsonc', 'wrangler.jsonc'], ['scripts/start.mjs', 'scripts/start.mjs'], ['Dockerfile.release', 'Dockerfile'], ['node_modules/ws', 'node_modules/ws']]) await cp(from, join(packageDir, to), { recursive: true })
  await cp(packageDir, nextDir, { recursive: true })
  const passwordFallback = fileURLToPath(new URL('./password.mjs', import.meta.resolve('@better-auth/utils/password')))
  await build({ entryPoints: ['worker/index.ts'], outfile: join(nextDir, 'worker.js'), bundle: true, format: 'esm', target: 'es2022', conditions: ['workerd', 'worker', 'browser'], alias: { '@better-auth/utils/password': passwordFallback }, external: ['cloudflare:*', 'node:*'], plugins: [{ name: 'release-fixture', setup(b) { b.onLoad({ filter: /shared\/build-info\.json$/ }, () => ({ contents: JSON.stringify(nextBuild), loader: 'json' })) } }] })
  await writeFile(join(nextDir, '.output/public/version.json'), JSON.stringify(nextBuild))
  await runCommand([...docker, 'build', '-t', baseImage, packageDir])
  const commonEnv = { STORAGE_ENDPOINT: 'http://files:9000', STORAGE_REGION: 'us-east-1', STORAGE_ACCESS_KEY_ID: access, STORAGE_SECRET_ACCESS_KEY: secret }
  const chat = (port, volume, bucket) => ({ image: '${ANYCORD_IMAGE}', ports: [`127.0.0.1:${port}:9876`], environment: { ...commonEnv, STORAGE_BUCKET: bucket, AUTH_BASE_URL: `http://127.0.0.1:${port}` }, volumes: [`${volume}:/app/.celld`], mem_limit: '512m' })
  await writeFile(composeFile, JSON.stringify({ services: {
    source: chat(19981, 'source-state', 'source-files'), target: chat(19982, 'target-state', 'target-files'),
    files: { image: 'rustfs/rustfs@sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c', command: '/data', environment: { RUSTFS_ACCESS_KEY: access, RUSTFS_SECRET_KEY: secret, RUSTFS_ADDRESS: ':9000', RUSTFS_CONSOLE_ENABLE: 'false', RUSTFS_OBS_LOGGER_LEVEL: 'error' }, ports: ['127.0.0.1:19980:9000'], volumes: ['files-state:/data'], mem_limit: '1g' },
  }, volumes: { 'source-state': {}, 'target-state': {}, 'files-state': {} } }), { mode: 0o600 })
  process.env.ANYCORD_IMAGE = baseImage
  await runCommand([...compose, 'up', '-d', 'files'])
  const s3 = new AwsClient({ accessKeyId: access, secretAccessKey: secret, region: 'us-east-1', service: 's3' })
  for (const bucket of ['source-files', 'target-files']) {
    let response
    for (let i = 0; i < 120; i++) { try { response = await s3.fetch('http://127.0.0.1:19980/' + bucket, { method: 'PUT' }); if (response.ok || response.status === 409) break } catch {} await delay(500) }
    assert(response?.ok || response?.status === 409, 'Disposable RustFS bucket setup failed')
  }
  await runCommand([...compose, 'up', '-d', 'source', 'target']); await Promise.all([ready(sourceOrigin), ready(targetOrigin)])
  process.env.ANYCORD_DOCKER_SOURCE_TOKEN = await token('source'); process.env.ANYCORD_DOCKER_TARGET_TOKEN = await token('target')
  const source = operationClient({ origin: sourceOrigin, migrationTokenEnv: 'ANYCORD_DOCKER_SOURCE_TOKEN' }), target = operationClient({ origin: targetOrigin, migrationTokenEnv: 'ANYCORD_DOCKER_TARGET_TOKEN' })
  const owner = await app(sourceOrigin, '/api/auth/register', { method: 'POST', body: { name: 'drillowner', password: 'correct-horse-battery' }, expected: 201 })
  const member = await app(sourceOrigin, '/api/auth/register', { method: 'POST', body: { name: 'drillmember', password: 'correct-horse-battery' }, expected: 201 })
  const community = await app(sourceOrigin, '/api/workspaces', { cookie: owner.cookie, method: 'POST', body: { name: 'Recovered community' }, expected: 201 })
  await app(sourceOrigin, '/api/integrations', { cookie: owner.cookie, method: 'PUT', body: { openrouterKey: 'local-drill-key-never-send' } })
  const file = Buffer.from([137,80,78,71,13,10,26,10,0,2,4,6]), attachment = (await app(sourceOrigin, '/api/channels/general/attachments', { cookie: owner.cookie, method: 'POST', body: { name: 'private.png', size: file.length }, expected: 201 })).data.id
  await app(sourceOrigin, `/api/attachments/${attachment}/upload`, { cookie: owner.cookie, method: 'PUT', body: file, raw: true })
  const id = randomUUID(), text='Real Docker/RustFS recovery point\nПривет 👋\nA\u0000B'; await app(sourceOrigin, '/api/channels/general/messages', { cookie: owner.cookie, method: 'POST', body: { id, text, attachmentIds: [attachment] }, expected: 201 })
  const jobId = randomUUID(), runnerId = randomUUID(); await source('/enqueue', { method: 'POST', body: { id: jobId, kind: 'backup' } })
  const claim = await source('/claim', { method: 'POST', body: { runnerId } }), backupStarted = Date.now()
  const backup = await createBackup(source, claim.job, claim.key, join(root, 'backups')), backupMs = Date.now() - backupStarted
  const restoreStarted = Date.now(); await restoreBackup(target, backup.path, runnerId); const restoreMs = Date.now() - restoreStarted
  const restored = await app(targetOrigin, '/api/auth/login', { method: 'POST', body: { name: 'drillowner', password: 'correct-horse-battery' } })
  assert((await app(targetOrigin, '/api/bootstrap', { cookie: restored.cookie })).data.workspaces.some(w => w.id === community.data.id))
  assert((await app(targetOrigin, '/api/channels/general/messages', { cookie: restored.cookie })).data.some(m=>m.id===id&&m.text===text),'Portable restore preserves Unicode/multiline/NUL text')
  const download = (await app(targetOrigin, `/api/attachments/${attachment}/download`, { cookie: restored.cookie })).data
  assert.deepEqual(Buffer.from((await app(targetOrigin, download.url, { raw: true })).data), file)
  await app(targetOrigin, '/api/bootstrap', { cookie: owner.cookie, expected: 401 })
  assert((await target('/status')).outboundDisabled)
  const sourceId = (await source('/status')).installationId, sourceToken = process.env.ANYCORD_DOCKER_SOURCE_TOKEN
  await activateCelld({ directory: nextDir, manifest: nextBuild }, { origin: sourceOrigin, celld: { composeFile, project, service: 'source', ...(context ? { context } : {}) } })
  await ready(sourceOrigin); await verifyInstallation(sourceOrigin, nextBuild)
  assert.equal(await token('source'), sourceToken); assert.equal((await source('/status')).installationId, sourceId)
  assert((await app(sourceOrigin, '/api/channels/general/messages', { cookie: member.cookie })).data.some(m => m.id === id))
  const a = await connect(sourceOrigin, owner.cookie), b = await connect(sourceOrigin, member.cookie), nextId = randomUUID()
  await app(sourceOrigin, '/api/channels/general/messages', { cookie: owner.cookie, method: 'POST', body: { id: nextId, text: 'After real Compose replacement' }, expected: 201 })
  await Promise.all([a.until(e => e.type === 'message' && e.message.id === nextId), b.until(e => e.type === 'message' && e.message.id === nextId)])
  assert((await target('/status')).outboundDisabled, 'Source replacement does not change destination')
  console.log(`PASS real celld Docker/RustFS: backup ${backupMs}ms; isolated restore ${restoreMs}ms; account/community/private file/session recovery; Compose release replacement preserves state/token/accounts; two-client realtime and writes afterward`)
} finally {
  for (const ws of clients) ws.terminate()
  await runCommand([...compose, 'down', '--volumes', '--remove-orphans']).catch(() => {})
  for (const image of [baseImage, updatedImage]) await runCommand([...docker, 'image', 'rm', image]).catch(() => {})
  delete process.env.ANYCORD_DOCKER_SOURCE_TOKEN; delete process.env.ANYCORD_DOCKER_TARGET_TOKEN; delete process.env.ANYCORD_IMAGE
  await rm(root, { recursive: true, force: true })
}

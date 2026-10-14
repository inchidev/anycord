import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
const base = process.env.ANYCORD_URL || 'https://anycord.inchi.dev'
let expected
try { expected = JSON.parse(await readFile('version.json', 'utf8')) }
catch { expected = JSON.parse(await readFile('.output/public/version.json', 'utf8')) }
if (process.env.MIGRATION_TOKEN) {
  const response = await fetch(base + '/api/_migrate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Migration-Token': process.env.MIGRATION_TOKEN }, body: '{}' })
  assert(response.ok, `Application migration failed (${response.status})`)
}
let healthy = false
for (let i = 0; i < 20; i++) {
  try {
    const response = await fetch(base + '/api/health', { cache: 'no-store' })
    const health = await response.json()
    if (response.ok && health.schema === expected.schema && health.build?.version === expected.version && health.build?.commit === expected.commit) { healthy = true; break }
  } catch {}
  await delay(2000)
}
assert(healthy, 'Deployment health/schema/version check failed. Check migration credentials and the deployed artifact.')
const runtime = await (await fetch(base + '/api/runtime', { cache: 'no-store' })).json()
assert.equal(runtime.apiVersion, expected.apiVersion)
assert.deepEqual(runtime.build, expected)
const version = await (await fetch(base + '/version.json', { cache: 'no-store' })).json()
assert.deepEqual(version, expected, 'Client and Worker release differ')
for (const path of ['/', '/login', '/servers', '/invite', '/recover', '/main/general', '/brand/anycord-symbol.png', '/manifest.webmanifest', '/sw.js']) assert((await fetch(base + path)).ok, path)
console.log('PASS: deployment schema, exact client/Worker version and source commit, routes and PWA assets.')


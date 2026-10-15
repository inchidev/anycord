import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
const base = process.env.ANYCORD_URL || 'https://anycord.inchi.dev'
let expected
try { expected = JSON.parse(await readFile('version.json', 'utf8')) }
catch { expected = JSON.parse(await readFile('.output/public/version.json', 'utf8')) }
const options = { cache: 'no-store' }
let healthy = false, lastError
for (let i = 0; i < 40; i++) {
  try {
    // A completed upload may still serve the prior Worker/client briefly. Repeat
    // the idempotent migration and verify all identities in the same retry loop.
    if (process.env.MIGRATION_TOKEN) {
      const migrated = await fetch(base + '/api/_migrate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Migration-Token': process.env.MIGRATION_TOKEN }, body: '{}', signal: AbortSignal.timeout(10_000), redirect: 'error' })
      assert(migrated.ok, `Application migration failed (${migrated.status})`)
      await migrated.body?.cancel()
    }
    const response = await fetch(base + '/api/health', { ...options, signal: AbortSignal.timeout(10_000) })
    const health = await response.json()
    assert(response.ok && health.ok && health.schema === expected.schema, 'Deployment health/schema differs')
    assert.deepEqual(health.build, expected, 'Worker release differs')
    const runtime = await (await fetch(base + '/api/runtime', { ...options, signal: AbortSignal.timeout(10_000) })).json()
    assert.equal(runtime.apiVersion, expected.apiVersion)
    assert.deepEqual(runtime.build, expected)
    const version = await (await fetch(base + '/version.json', { ...options, signal: AbortSignal.timeout(10_000) })).json()
    assert.deepEqual(version, expected, 'Client and Worker release differ')
    healthy = true; break
  } catch (error) { lastError = error }
  await delay(2000)
}
assert(healthy, `Deployment health/schema/version check failed: ${lastError?.message || 'no healthy response'}`)
for (const path of ['/', '/login', '/servers', '/invite', '/join', '/recover', '/main/general', '/brand/anycord-symbol.png', '/manifest.webmanifest', '/sw.js']) assert((await fetch(base + path)).ok, path)
console.log('PASS: deployment schema, exact client/Worker version and source commit, routes and PWA assets.')


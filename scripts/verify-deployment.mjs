import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
const base = process.env.ANYCORD_URL || 'https://anycord.inchi.dev'
const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'))
if (process.env.MIGRATION_TOKEN) {
  const response = await fetch(base + '/api/_migrate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Migration-Token': process.env.MIGRATION_TOKEN }, body: '{}' })
  assert(response.ok, `Application migration failed (${response.status})`)
}
let healthy = false
for (let i = 0; i < 20; i++) {
  try { const response = await fetch(base + '/api/health'); const health = await response.json(); if (response.ok && health.schema === journal.entries.at(-1).tag) { healthy = true; break } } catch {}
  await delay(2000)
}
assert(healthy, 'Deployment health/schema check failed. Configure the MIGRATION_TOKEN build secret for application migrations.')
for (const path of ['/', '/login', '/servers', '/main/general', '/brand/anycord-symbol.png']) assert((await fetch(base + path)).ok, path)
console.log('PASS: public deployment health, schema, client routes and brand asset.')

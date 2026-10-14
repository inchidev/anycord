import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const base = process.env.CHAT_URL || 'http://127.0.0.1:9876'
const health = await fetch(`${base}/api/health`)
assert.equal(health.status, 200)
const data = await health.json()
assert.equal(data.storage, 'D1')
const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'))
assert.equal(data.schema, journal.entries.at(-1).tag)
const html = await (await fetch(base)).text()
assert.match(html, /Anycord/)
const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1])
assert(assets.length > 0)
for (const path of assets) assert.equal((await fetch(new URL(path, base))).status, 200, path)
const auth = await fetch(`${base}/api/auth/status`)
assert.equal(auth.status, 200)
const unauthorized = await fetch(`${base}/api/bootstrap`)
assert.equal(unauthorized.status, 401)
console.log('PASS: Nuxt assets, migrated D1 health, authentication status, and unauthorized access. No application data changed.')

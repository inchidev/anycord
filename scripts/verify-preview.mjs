import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

export async function waitForPreview(origin, expected, { request = fetch, sleep = delay, attempts = 30 } = {}) {
  const deadline = Date.now() + 120_000
  const get = async path => {
    const response = await request(origin + path, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) })
    assert(response.ok, 'Preview response is not ready')
    return response
  }
  // Worker routing and static assets can propagate at different times, especially
  // after destroy/recreate. Require one complete pass with the exact identity.
  for (let attempt = 0; attempt < attempts && Date.now() < deadline; attempt++) {
    try {
      const health = await (await get('/api/health')).json()
      assert(health.ok); assert.equal(health.schema, expected.schema); assert.deepEqual(health.build, expected)
      const runtime = await (await get('/api/runtime')).json()
      assert.equal(runtime.engine, 'cloudflare'); assert.equal(runtime.apiVersion, expected.apiVersion); assert.deepEqual(runtime.build, expected)
      assert.deepEqual(await (await get('/version.json')).json(), expected)
      for (const path of ['/login', '/servers', '/manifest.webmanifest', '/sw.js']) await get(path)
      return
    } catch {}
    if (attempt + 1 < attempts) await sleep(2000)
  }
  throw new Error('Preview client/runtime identity and PWA routes did not become ready within the verification window')
}

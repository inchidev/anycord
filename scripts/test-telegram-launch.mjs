import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { chromium } from 'playwright'

// Exercise the generated Nuxt app, including its real router/plugin order.
// Provider and app API responses use synthetic data; no real identity/token is used.
const root = resolve(process.env.ANYCORD_CLIENT_DIR || '.output/public')
const build = JSON.parse(await readFile(resolve(root, 'version.json'), 'utf8'))
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://local').pathname))
    assert(path === root || path.startsWith(root + '/'))
    let file = path, bytes
    try { bytes = await readFile(file) } catch { file = resolve(root, 'app-shell.html'); bytes = await readFile(file) }
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); response.end(bytes)
  } catch { response.writeHead(404); response.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
let browser
try {
  browser = await chromium.launch({ headless: true })
  const user = { id: 'fixture-member', name: 'Test member', role: 'member', color: '#5865f2' }
  const signed = new URLSearchParams({
    query_id: 'synthetic-query',
    user: JSON.stringify({ id: 424242, first_name: 'Test', last_name: 'Member', photo_url: 'https://example.invalid/avatar.svg' }).replaceAll('/', '\\/'),
    auth_date: String(Math.floor(Date.now() / 1000)), signature: Buffer.alloc(64, 3).toString('base64url'), hash: 'f'.repeat(64),
  }).toString()
  const launch = new URLSearchParams({ tgWebAppData: signed, tgWebAppVersion: '9.6', tgWebAppPlatform: 'web', tgWebAppThemeParams: JSON.stringify({ bg_color: '#212121' }) }).toString()
  for (const entry of ['/login', '/main']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
    const page = await context.newPage()
    let authenticated = false
    const attempts = []
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname
      let body = {}, status = 200
      if (path === '/api/auth/telegram/miniapp') {
        const input = route.request().postDataJSON(); attempts.push(input.initData)
        authenticated = input.initData === signed
        status = authenticated ? 200 : 401; body = authenticated ? { ok: true } : { message: 'Invalid launch data' }
      } else if (path === '/api/auth/status') body = { initialized: true, setupRequired: false, user: authenticated ? user : null, methods: { passwordLogin: true, registration: true, telegramLogin: true, miniAppLogin: true } }
      else if (path === '/api/runtime') body = { apiVersion: 1, engine: 'cloudflare', auth: 'better-auth', realtime: 'websocket', build }
      else if (path === '/api/workspaces') body = []
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.goto(base + entry + '#' + launch, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => !document.body.textContent.includes('Opening your account'), { timeout: 10_000 })
    assert.equal(attempts.length, 1, `${entry}: should attempt Mini App auto-login once`)
    assert.equal(attempts[0], signed, `${entry}: router must not alter Telegram's signed query string`)
    assert(!page.url().includes('tgWebAppData'), `${entry}: signed launch data must not enter navigation URLs`)
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => (localStorage.getItem(key) || '').includes('synthetic-query'))), false)
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => (sessionStorage.getItem(key) || '').includes('synthetic-query'))), false)
    await context.close()
    console.log(`PASS ${entry}: exact Telegram launch data reaches auto-login before/after Nuxt routing; no URL/storage persistence`)
  }
  const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage()
  let calls = 0
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/auth/telegram/miniapp') calls++
    const body = path === '/api/runtime' ? { apiVersion: 1, engine: 'cloudflare', auth: 'better-auth', realtime: 'websocket', build }
      : { initialized: true, setupRequired: false, user: null, methods: { passwordLogin: true, registration: true, telegramLogin: true, miniAppLogin: true } }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.goto(base + '/login', { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Welcome back.' }).waitFor()
  assert.equal(calls, 0, 'Ordinary browser navigation must not attempt Mini App authentication')
  await context.close()
  console.log('PASS ordinary browser login does not fabricate Telegram launch data')
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }

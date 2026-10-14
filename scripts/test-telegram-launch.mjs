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
  const user = { id: 'fixture-member', name: 'Иван Мотовилов', role: 'member', color: '#5865f2', avatarUrl: 'https://t.me/i/userpic/320/fixture.jpg', telegram: true }
  const avatar = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#425388"/><circle cx="40" cy="29" r="14" fill="#b7c6e9"/><path d="M12 80c0-36 56-36 56 0" fill="#b7c6e9"/></svg>'
  const signed = new URLSearchParams({
    query_id: 'synthetic-query',
    user: JSON.stringify({ id: 424242, first_name: 'Test', last_name: 'Member', photo_url: 'https://example.invalid/avatar.svg' }).replaceAll('/', '\\/'),
    auth_date: String(Math.floor(Date.now() / 1000)), signature: Buffer.alloc(64, 3).toString('base64url'), hash: 'f'.repeat(64),
  }).toString()
  const launch = new URLSearchParams({ tgWebAppData: signed, tgWebAppVersion: '9.6', tgWebAppPlatform: 'web', tgWebAppThemeParams: JSON.stringify({ bg_color: '#212121' }) }).toString()
  for (const entry of ['/login', '/main', '/servers', '/login?next=/main/general']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
    const page = await context.newPage()
    await page.route(user.avatarUrl, route => route.fulfill({ contentType: 'image/svg+xml', body: avatar }))
    await page.addInitScript(() => {
      // Model a Telegram WebView without service worker support.
      delete Navigator.prototype.serviceWorker
      sessionStorage.setItem('__telegram__initParams', JSON.stringify({ tgWebAppData: 'legacy-sensitive-launch' }))
      window.loginFormSeen = false
      new MutationObserver(() => { if (document.querySelector('.auth-card')) window.loginFormSeen = true }).observe(document, { childList: true, subtree: true })
    })
    await page.route('https://telegram.org/js/telegram-web-app.js', route => route.fulfill({ contentType: 'text/javascript', body: `
      // Behave like the provider SDK: persist UI params and publish live CSS insets.
      sessionStorage.setItem('__telegram__initParams', JSON.stringify({ ...JSON.parse(sessionStorage.getItem('__telegram__initParams') || '{}'), ...Object.fromEntries(new URLSearchParams(location.hash.slice(1))) }));
      window.Telegram = { WebApp: { initData: '', ready() {}, setHeaderColor(color) { this.headerColor = color }, setBackgroundColor() {} } };
      window.setTelegramInsets = (top, bottom, left = 0, right = 0) => {
        const root = document.documentElement;
        root.style.setProperty('--tg-safe-area-inset-top', '44px');
        root.style.setProperty('--tg-content-safe-area-inset-top', top + 'px');
        root.style.setProperty('--tg-safe-area-inset-bottom', bottom + 'px');
        root.style.setProperty('--tg-safe-area-inset-left', left + 'px');
        root.style.setProperty('--tg-content-safe-area-inset-right', right + 'px');
      };
      window.setTelegramInsets(56, 34);
    ` }))
    let authenticated = false
    const attempts = []
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname
      let body = {}, status = 200
      if (path === '/api/auth/telegram/miniapp') {
        const input = route.request().postDataJSON(); attempts.push(input.initData)
        await new Promise(resolve => setTimeout(resolve, 350))
        authenticated = input.initData === signed
        status = authenticated ? 200 : 401; body = authenticated ? { ok: true } : { message: 'Invalid launch data' }
      } else if (path === '/api/auth/status') body = { initialized: true, setupRequired: false, user: authenticated ? user : null, methods: { passwordLogin: true, registration: true, telegramLogin: true, miniAppLogin: true } }
      else if (path === '/api/runtime') body = { apiVersion: 1, engine: 'cloudflare', auth: 'better-auth', realtime: 'websocket', build }
      else if (path === '/api/workspaces') body = []
      else if (path === '/api/bootstrap') body = { user, workspaces: [{ id: 'main', name: 'Anycord', initials: 'AN', role: 'member' }], channels: [{ id: 'general', workspaceId: 'main', name: 'general', kind: 'text', topic: '' }], members: [] }
      else if (path.endsWith('/messages')) body = []
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.goto(base + entry + '#' + launch, { waitUntil: 'networkidle' })
    await page.waitForURL(url => url.pathname === (entry.includes('next=') ? '/main/general' : '/servers'))
    await page.locator(entry.includes('next=') ? '.discord-shell' : '.server-choice').first().waitFor()
    assert.equal(attempts.length, 1, `${entry}: should attempt Mini App auto-login once`)
    assert.equal(attempts[0], signed, `${entry}: router must not alter Telegram's signed query string`)
    assert.equal(await page.evaluate(() => window.loginFormSeen), false, `${entry}: login form must never render during Mini App session resolution`)
    assert(!page.url().includes('tgWebAppData'), `${entry}: signed launch data must not enter navigation URLs`)
    assert.equal(await page.evaluate(() => Object.keys(localStorage).some(key => (localStorage.getItem(key) || '').includes('synthetic-query'))), false)
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => (sessionStorage.getItem(key) || '').includes('synthetic-query'))), false)
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some(key => (sessionStorage.getItem(key) || '').includes('legacy-sensitive-launch'))), false)
    if (!entry.includes('next=')) {
      await page.locator('.picker-avatar img').waitFor()
      assert.equal(await page.locator('.picker-account strong').innerText(), user.name)
      await page.getByText('Telegram account', { exact: true }).waitFor()
      await page.waitForFunction(() => window.Telegram.WebApp.headerColor === '#1e1f22')
      assert((await page.locator('.picker-nav').boundingBox()).y >= 100, 'directory chrome must clear system (44px) + Telegram (56px) controls')
      await page.evaluate(() => window.setTelegramInsets(20, 10, 12, 18))
      assert.equal((await page.locator('.picker-nav').boundingBox()).y, 64, 'live SDK inset changes must update the layout')
      const nav = await page.locator('.picker-nav').boundingBox()
      assert(nav.x >= 12 && nav.x + nav.width <= 372, 'side insets must keep controls clear in landscape')
      await page.reload({ waitUntil: 'networkidle' })
      await page.locator('.server-choice').first().waitFor()
      assert.equal(attempts.length, 1, 'reload must reuse the session without persisting/replaying signed launch data')
      assert((await page.locator('.picker-nav').boundingBox()).y >= 100, 'safe areas must survive reloads after the signed fragment is removed')
      assert.equal(await page.evaluate(() => window.loginFormSeen), false, 'reload must not flash a login form')
      if (entry === '/servers') {
        await page.route(user.avatarUrl, route => route.abort())
        await page.reload({ waitUntil: 'networkidle' })
        await page.locator('.picker-avatar .avatar-initials').waitFor()
        assert.equal(await page.locator('.picker-avatar').innerText(), 'ИМ', 'unavailable photos must fall back to name initials')
      }
    } else {
      await page.waitForFunction(() => window.Telegram.WebApp.headerColor === '#313338')
      assert.equal(await page.evaluate(() => getComputedStyle(document.body, '::before').backgroundColor), 'rgb(49, 51, 56)', 'safe-area paint must match the chat header')
      const bounds = await page.locator('.chat-header').boundingBox()
      assert(bounds.y >= 100, 'chat header must clear Telegram UI')
      const composer = await page.locator('.message-composer').boundingBox()
      assert(composer.y + composer.height <= 844, 'composer must fit inside the viewport')
      await page.locator('.mobile-menu').click()
      await page.locator('.server-heading').click()
      await page.getByRole('menuitem', { name: 'Your connections', exact: true }).click()
      await page.getByRole('dialog', { name: 'Your connections', exact: true }).waitFor()
      const dialogBounds = await page.getByRole('dialog', { name: 'Your connections', exact: true }).boundingBox()
      assert(dialogBounds.y >= 100 && dialogBounds.y + dialogBounds.height <= 810, 'teleported dialogs must clear top/bottom controls')
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Close server navigation' }).click()
      await page.locator('.composer-input textarea').focus()
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => 500 })
        window.visualViewport.dispatchEvent(new Event('resize'))
      })
      await page.locator('.discord-shell.keyboard-open').waitFor()
      const keyboardComposer = await page.locator('.message-composer').boundingBox()
      assert(keyboardComposer.y + keyboardComposer.height <= 500, 'keyboard resize must keep the composer in the visible viewport')
      assert.equal(await page.locator('.message-composer').evaluate(el => getComputedStyle(el).paddingBottom), '16px', 'keyboard must not add an extra home-indicator gap')
    }
    await context.close()
    console.log(`PASS ${entry}: exact launch data, one sign-in, no login flash or identity persistence; live safe areas`)
  }
  for (const mode of ['existing-session', 'profile-mismatch', 'expired-launch', 'disabled', 'setup', 'sdk-unavailable', 'remote-installation']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }), page = await context.newPage()
    let calls = 0, profileCalls = 0, authenticated = ['existing-session', 'profile-mismatch'].includes(mode)
    await page.route(user.avatarUrl, route => route.fulfill({ contentType: 'image/svg+xml', body: avatar }))
    await page.addInitScript(mode => {
      delete Navigator.prototype.serviceWorker
      if (mode === 'remote-installation') {
        localStorage.setItem('anycord-connections', JSON.stringify([{ origin: 'https://remote.example', name: 'Remote installation' }]))
        localStorage.setItem('anycord-active-connection', 'https://remote.example')
      }
    }, mode)
    await page.route('https://telegram.org/js/telegram-web-app.js', route => mode === 'sdk-unavailable' ? route.abort() : route.fulfill({ contentType: 'text/javascript', body: 'window.Telegram = { WebApp: { ready() {} } };' }))
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname
      let body = {}, status = 200
      if (path === '/api/auth/telegram/miniapp') {
        calls++
        assert.equal(route.request().postDataJSON().initData, signed)
        await new Promise(resolve => setTimeout(resolve, 100))
        if (mode === 'expired-launch') { status = 401; body = { message: 'Telegram login expired. Reopen the Mini App.' } }
        else authenticated = true
      } else if (path === '/api/auth/status') body = { initialized: mode !== 'setup', user: authenticated ? user : null, methods: { passwordLogin: true, registration: true, telegramLogin: true, miniAppLogin: mode !== 'disabled' } }
      else if (path === '/api/account/telegram/profile') { profileCalls++; assert.equal(route.request().postDataJSON().initData, signed); body = mode === 'profile-mismatch' ? { ...user, id: 'different-account', name: 'Someone else' } : user }
      else if (path === '/api/auth/logout') { authenticated = false; body = { success: true } }
      else if (path === '/api/bootstrap') body = { user, workspaces: mode === 'existing-session' ? [{ id: 'main', name: 'Anycord', initials: 'AN', role: 'member' }] : [], channels: [], members: [] }
      else if (path === '/api/runtime') body = { apiVersion: 1, engine: 'cloudflare', auth: 'better-auth', realtime: 'websocket', build }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.goto(base + '/servers#' + launch, { waitUntil: 'networkidle' })
    if (['existing-session', 'profile-mismatch', 'sdk-unavailable'].includes(mode)) await page.getByRole('heading', { name: 'Servers', exact: true }).waitFor()
    else await page.getByRole('heading', { name: mode === 'setup' ? 'Create the first account' : mode === 'remote-installation' ? 'Log in to your installation' : 'Welcome back.', exact: true }).waitFor()
    assert.equal(calls, ['expired-launch', 'sdk-unavailable'].includes(mode) ? 1 : 0, `${mode}: avoid retries or bypassing installation policy`)
    if (mode === 'profile-mismatch') assert.equal(await page.locator('.picker-account strong').innerText(), user.name, 'a profile result for another session must not replace the current user')
    if (mode === 'expired-launch') await page.getByText('Telegram login expired. Reopen the Mini App.', { exact: true }).waitFor()
    if (mode === 'existing-session') {
      assert.equal(profileCalls, 1, 'existing sessions refresh verified profile data without signing in again')
      await page.locator('a.server-choice').click()
      await page.getByRole('button', { name: 'Open channels', exact: true }).click()
      await page.getByRole('button', { name: 'User Settings', exact: true }).click()
      await page.locator('.account-session').getByRole('button', { name: 'Log Out', exact: true }).click()
      await page.waitForTimeout(400)
      assert.equal(calls, 0, 'explicit logout must not trigger automatic Telegram reauthentication')
      await page.getByRole('heading', { name: 'Welcome back.', exact: true }).waitFor()
    }
    await context.close()
    console.log(`PASS ${mode}: existing sessions, failure fallback and installation policy remain usable`)
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

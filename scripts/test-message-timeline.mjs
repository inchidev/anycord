import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { chromium } from 'playwright'
import { permissionKeys } from '../runtime/contracts.mjs'

// Real generated Vue app and router, with disposable API fixtures only.
const root = resolve('.output/public'), build = JSON.parse(await readFile(resolve(root, 'version.json'), 'utf8'))
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }
const server = createServer(async (request, response) => {
  try {
    let file = resolve(root, '.' + new URL(request.url, 'http://local').pathname)
    assert(file === root || file.startsWith(root + '/'))
    let bytes
    try { bytes = await readFile(file) } catch { file = resolve(root, 'app-shell.html'); bytes = await readFile(file) }
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); response.end(bytes)
  } catch { response.writeHead(404); response.end() }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ headless: true })
const message = (channelId, index, threadId = null) => ({ id: `${threadId || channelId}-${index}`, channelId, authorId: 'owner', author: 'Owner', color: '#5865f2', text: `Message ${index}\n${'A variable height message. '.repeat(index % 5 + 1)}`, createdAt: 1700000000000 + index * 1000, editedAt: null, bot: false, attachments: [], reactions: [], replyToId: null, threadId, reply: null, thread: null })
async function eventually(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 50)) }
  assert.fail(label)
}
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block' }), page = await context.newPage(), errors = []
    const user = { id: 'owner', name: 'Owner', role: 'owner', color: '#5865f2' }
    const rows = Object.fromEntries(['general', 'other'].map(id => [id, Array.from({ length: 100 }, (_, i) => message(id, i + 1))]))
    rows.general[99].attachments = [{ id: '11111111-1111-4111-8111-111111111111', name: 'picture.svg', size: 100, contentType: 'image/svg+xml' }]
    let releaseImage
    const imageReady = new Promise(resolve => { releaseImage = resolve })
    await page.route('**/fixture-image.svg', async route => { await imageReady; await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="blue"/></svg>' }) })
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => { delete Navigator.prototype.serviceWorker })
    let liveSocket
    await page.routeWebSocket('**/api/workspaces/*/ws', socket => { liveSocket = socket; socket.onMessage(() => {}) })
    await page.route('https://telegram.org/js/telegram-web-app.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }))
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()), path = url.pathname
      let body = {}, status = 200
      if (path === '/api/runtime') body = { apiVersion: 1, engine: 'cloudflare', auth: 'better-auth', realtime: 'websocket', build }
      else if (path === '/api/auth/status') body = { initialized: true, user }
      else if (path === '/api/attachments/11111111-1111-4111-8111-111111111111/download') body = { url: '/fixture-image.svg' }
      else if (path === '/api/bootstrap') body = { user, workspaces: [{ id: 'main', name: 'Anycord', initials: 'AN', role: 'owner', permissions: permissionKeys }], channels: ['general', 'other'].map(id => ({ id, workspaceId: 'main', name: id, kind: 'text', topic: '', permissions: permissionKeys })), members: [] }
      else if (path.endsWith('/messages')) {
        const id = path.split('/')[3]
        body = url.searchParams.has('focus') ? Array.from({ length: 100 }, (_, i) => message(id, i + 1001)) : rows[id]
        if (url.searchParams.get('focus') === 'deleted') { body = { error: 'Message not found' }; status = 404 }
      } else if (path === '/api/search') body = [{ ...message('general', 1050), channel: 'general' }]
      else if (path.endsWith('/threads/t1/follow')) body = { following: false }
      else if (path.endsWith('/threads/t1')) body = { thread: { id: 't1', channelId: 'general', name: 'Test thread', messageCount: 100, parentMessageId: 'general-1', authorId: 'owner', createdAt: 1 }, parent: message('general', 1), messages: Array.from({ length: 100 }, (_, i) => message('general', i + (url.searchParams.has('focus') ? 1001 : 1), 't1')) }
      else if (path.endsWith('/commands') || path.endsWith('/threads')) body = []
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    })
    const timeline = page.getByRole('log', { name: 'Channel messages', exact: true })
    const atEnd = () => timeline.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop < 3)
    async function navigate(path) {
      // Exercise SPA navigation and cached channel collections, without reloading.
      // The router's real channel links exercise its normal click path.
      if (width === 390) await page.getByRole('button', { name: 'Open channels', exact: true }).click()
      await page.locator('.channel-scroll').getByRole('button', { name: path.split('/').at(-1), exact: true }).click()
    }
    await page.goto(base + '/main/general', { waitUntil: 'domcontentloaded' })
    await timeline.locator('#message-general-100').waitFor()
    await eventually(() => atEnd(), `${width}: opening a channel must land at latest`)
    releaseImage()
    await eventually(() => timeline.locator('img[alt="picture.svg"]').evaluate(el => el.complete && el.naturalHeight > 0), 'fixture image loaded')
    await eventually(() => atEnd(), `${width}: delayed attachments must keep the latest message in view`)
    await page.setViewportSize({ width, height: 600 })
    await eventually(() => atEnd(), `${width}: resizing the viewport must keep latest visible`)
    await page.setViewportSize({ width, height: 844 })
    await timeline.evaluate(el => { el.scrollTop = 0 })
    await navigate('/main/other')
    await eventually(() => atEnd(), `${width}: switching channels from older messages must land at latest`)
    await timeline.evaluate(el => { el.scrollTop = 0 })
    await navigate('/main/general')
    await eventually(() => atEnd(), `${width}: reopening a cached channel must land at latest`)
    await eventually(async () => (await timeline.locator('.message-row').count()) < 40, `${width}: only visible messages and overscan should mount`)
    const append = index => {
      const next = message('general', index)
      rows.general = [...rows.general, next].slice(-100)
      liveSocket.send(JSON.stringify({ type: 'message', message: next }))
    }
    append(101)
    await eventually(async () => await timeline.locator('#message-general-101').count() === 1 && await atEnd(), `${width}: live messages follow latest`)
    await timeline.evaluate(el => { el.scrollTop -= 2000 })
    await eventually(async () => await timeline.locator('#message-general-101').count() === 0, 'scroll up outside latest overscan')
    const readingAnchor = await timeline.evaluate(el => {
      const top = el.getBoundingClientRect().top
      const row = [...el.querySelectorAll('.message-row')].find(row => row.getBoundingClientRect().top >= top)
      return { id: row.id, index: Number(row.closest('[data-index]').dataset.index), offset: row.getBoundingClientRect().top - top }
    })
    append(102)
    await eventually(async () => timeline.locator(`#${readingAnchor.id}`).evaluate((el, index) => Number(el.closest('[data-index]').dataset.index) === index - 1, readingAnchor.index), 'live append must reach the rendered collection before checking its scroll position')
    await eventually(async () => page.evaluate(anchor => {
      const el = document.getElementById(anchor.id), viewport = document.querySelector('[aria-label="Channel messages"]')
      return !!el && Math.abs(el.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset) < 3
    }, readingAnchor), `${width}: a live append and bounded-window trim preserve the reading position`)
    assert.equal(await atEnd(), false, 'new messages must not pull the reader to latest')
    await timeline.evaluate(el => { el.scrollTop = 0 })
    const latest = page.getByRole('button', { name: 'Go to latest messages', exact: true })
    await latest.click()
    await eventually(() => atEnd(), `${width}: latest button must scroll even without a search hash`)
    if (width === 390) await page.getByRole('button', { name: 'Search messages', exact: true }).click()
    const input = width === 390 ? page.getByRole('textbox', { name: 'Search this server', exact: true }).last() : page.getByRole('textbox', { name: 'Search this server', exact: true }).first()
    await input.fill('Message 1050'); await input.press('Enter')
    await page.getByRole('button', { name: /Jump to message/ }).click()
    await eventually(async () => {
      const target = timeline.locator('#message-general-1050')
      if (!(await target.count())) return false
      return target.evaluate(el => { const parent = el.closest('[role="log"]'), a = el.getBoundingClientRect(), b = parent.getBoundingClientRect(); return a.top >= b.top && a.bottom <= b.bottom && getComputedStyle(el).borderLeftWidth === '2px' })
    }, `${width}: search must mount and reveal its virtualized target`)
    await mkdir('output/playwright', { recursive: true })
    await page.screenshot({ path: `output/playwright/message-timeline-${width}.png` })
    await latest.click()
    await eventually(async () => !new URL(page.url()).hash && await atEnd() && await timeline.locator('#message-general-102').count() === 1, `${width}: leaving search history must load and scroll latest`)
    await page.goto(base + '/main/general#message-deleted', { waitUntil: 'networkidle' })
    await page.getByText('Messages couldn’t load. Your draft is safe.', { exact: true }).waitFor()
    await latest.click()
    await eventually(async () => !new URL(page.url()).hash && await atEnd() && await timeline.locator('#message-general-102').count() === 1, `${width}: a deleted search target must allow returning to latest`)
    // Thread uses the same interaction, including direct focused links.
    await page.goto(base + '/main/general?thread=t1#message-t1-1050', { waitUntil: 'networkidle' })
    const thread = page.getByRole('log', { name: 'Thread messages', exact: true })
    await eventually(async () => await thread.locator('#message-t1-1050').count() === 1, `${width}: thread target must mount`)
    await page.getByRole('button', { name: 'Go to latest messages', exact: true }).last().click()
    await eventually(async () => await thread.locator('#message-t1-100').count() === 1 && await thread.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop < 3), `${width}: thread latest`)
    assert.deepEqual(errors, [], 'no client exceptions')
    await context.close()
  }
  console.log('PASS: desktop/mobile initial, switched and cached channel scrolling; delayed images; viewport resizing; virtual rows; live append and reading-position preservation; search focus; latest buttons; thread history.')
} finally { await browser.close(); await new Promise(r => server.close(r)) }

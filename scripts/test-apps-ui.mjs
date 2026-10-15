import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { chromium } from 'playwright'
const root = resolve('.output/public'), build = JSON.parse(await readFile(resolve(root, 'version.json'), 'utf8'))
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png' }
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
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' }), page = await context.newPage()
    const user = { id: 'owner', name: 'Owner', role: 'owner', color: '#5865f2' }, errors = [], apps = [], posts = [], hooks = []
    let failNext = false
    let policy = { enabled: true, allowedOrigins: [] }
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => { delete Navigator.prototype.serviceWorker })
    await page.route('https://telegram.org/js/telegram-web-app.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }))
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname, method = request.method()
      let body = {}, status = 200
      if (path === '/api/runtime') body = { apiVersion: 1, engine: 'cloudflare', auth: 'better-auth', realtime: 'websocket', build }
      else if (path === '/api/auth/status') body = { initialized: true, user }
      else if (path === '/api/bootstrap') body = { user, workspaces: [{ id: 'main', name: 'Anycord', initials: 'AN', role: 'owner' }], channels: [{ id: 'general', workspaceId: 'main', name: 'general', kind: 'text', topic: '' }], members: [] }
      else if (path === '/api/integrations') body = { realtimeConfigured: false, realtimeAccountId: '', realtimeAppId: '', realtimePreset: 'group_call_participant', aiConfigured: false, aiModel: 'test', email: 'later' }
      else if (path === '/api/integrations/telegram') body = { botConfigured: false, botUsername: '', clientId: '', oidcConfigured: false, notifications: false, origin: base, callbackURL: base + '/callback', miniAppURL: base, webhookURL: base + '/webhook' }
      else if (path === '/api/installation/authentication') body = { passwordLogin: true, registration: true, telegramLogin: false, miniAppLogin: false }
      else if (path === '/api/installation/apps') { if (method === 'PUT') policy = request.postDataJSON(); body = policy }
      else if (path === '/api/workspaces/main/apps') {
        if (method === 'POST') {
          const input = request.postDataJSON(), app = { ...input, id: crypto.randomUUID(), workspaceId: 'main', createdAt: Date.now(), status: 'active', permissions: ['Post messages in authorized channels'] }
          apps.push(app); status = 201; body = { app, token: 'synthetic-app-token', signingSecret: 'synthetic-signing-secret' }
        } else body = { apps, policy }
      } else if (path.endsWith('/slack-webhooks')) {
        if (method === 'GET') body = hooks.map(({ url, ...metadata }) => metadata)
        else { const hook = { id: crypto.randomUUID(), channelId: request.postDataJSON().channelId, createdAt: Date.now(), url: `${base}/api/compat/slack/services/main/synthetic-id/synthetic-secret` }; hooks.push(hook); body = hook; status = 201 }
      } else if (/\/slack-webhooks\/[^/]+\/rotate$/.test(path)) { hooks[0].url = `${base}/api/compat/slack/services/main/synthetic-id/rotated-secret`; body = hooks[0] }
      else if (/\/slack-webhooks\/[^/]+$/.test(path)) { hooks.length = 0; body = { ok: true } }
      else if (/\/apps\/[^/]+\/rotate$/.test(path)) body = { app: apps[0], token: 'synthetic-rotated-token', signingSecret: 'synthetic-rotated-secret' }
      else if (/\/apps\/[^/]+$/.test(path)) {
        if (method === 'DELETE') { apps.length = 0; body = { ok: true } }
        else { Object.assign(apps[0], request.postDataJSON()); apps[0].status = apps[0].enabled ? 'active' : 'disabled'; body = apps[0] }
      } else if (path.endsWith('apps-audit') || path.endsWith('apps-deliveries') || path.endsWith('/messages')) body = []
      else if (path.startsWith('/api/channels/general/commands/')) body = { id: path.split('/').at(-1), status: 'failed', error: 'The app failed to respond after five attempts', message: null }
      else if (path === '/api/channels/general/commands') {
        if (method === 'GET') body = apps.filter(a => a.enabled).map(a => ({ appId: a.id, appName: a.name, name: 'ping', description: 'Check that this app is responding', arguments: [] }))
        else {
          const input = request.postDataJSON(); posts.push(input)
          body = failNext ? { id: input.id, status: 'pending', message: null, error: null } : { id: input.id, status: 'completed', error: null, message: { id: crypto.randomUUID(), channelId: 'general', authorId: 'app:bot', author: 'Ping Bot', avatarUrl: null, color: '#8b5cf6', text: 'Pong!', createdAt: Date.now(), editedAt: null, bot: true, attachments: [], reactions: [], replyToId: null, threadId: null, reply: null, thread: null } }
        }
      }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.goto(base + '/main/general', { waitUntil: 'networkidle' })
    if (width === 390) await page.getByRole('button', { name: 'Open channels', exact: true }).click()
    await page.locator('.server-heading').click()
    await page.getByRole('menuitem', { name: 'Server Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Apps & integrations', exact: true }).click()
    await page.getByRole('button', { name: 'Install app', exact: true }).click()
    await page.getByRole('combobox').click()
    await page.getByRole('option', { name: 'Ping example bot', exact: true }).click()
    await page.getByLabel('Bot name', { exact: true }).fill('Ping Bot')
    await page.getByRole('checkbox', { name: '#general', exact: true }).check()
    await page.getByRole('button', { name: 'Install app', exact: true }).click()
    await page.getByText('Save these secrets now', { exact: true }).waitFor()
    assert.equal(apps.length, 1); assert.equal(apps[0].kind, 'ping'); assert.deepEqual(apps[0].channelIds, ['general'])
    await page.getByRole('button', { name: 'I saved the secrets' }).click()
    await page.getByRole('button', { name: 'Rotate credentials' }).click()
    await page.getByText('Save these secrets now', { exact: true }).waitFor(); assert.equal(await page.getByLabel('App token', { exact: true }).inputValue(), 'synthetic-rotated-token')
    await page.getByRole('button', { name: 'I saved the secrets' }).click()
    await page.getByRole('button', { name: 'Create Slack webhook', exact: true }).click()
    await page.getByText('Save this webhook URL now', { exact: true }).waitFor()
    assert.equal(hooks.length, 1); assert.equal(hooks[0].channelId, 'general')
    assert((await page.getByLabel('Slack webhook URL', { exact: true }).inputValue()).endsWith('synthetic-secret'))
    await page.getByRole('button', { name: 'I saved the webhook URL', exact: true }).click()
    await page.getByRole('button', { name: 'Rotate URL', exact: true }).click()
    await page.getByText('Save this webhook URL now', { exact: true }).waitFor()
    assert((await page.getByLabel('Slack webhook URL', { exact: true }).inputValue()).endsWith('rotated-secret'))
    await page.getByRole('button', { name: 'I saved the webhook URL', exact: true }).click()
    await page.getByRole('button', { name: 'Revoke URL', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm revoke URL', exact: true }).click()
    await page.getByRole('button', { name: 'Create Slack webhook', exact: true }).waitFor()
    assert.equal(hooks.length, 0)
    await page.getByRole('button', { name: 'Disable', exact: true }).click()
    await page.getByRole('button', { name: 'Enable', exact: true }).waitFor(); assert.equal(apps[0].enabled, false)
    await page.getByRole('button', { name: 'Enable', exact: true }).click()
    await page.getByRole('button', { name: 'Disable', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Configure', exact: true }).click()
    await page.getByLabel('Bot name', { exact: true }).fill('Ping Bot renamed')
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await page.getByRole('heading', { name: 'Ping Bot renamed', exact: true }).waitFor()
    await mkdir('output/playwright', { recursive: true })
    await page.screenshot({ path: `output/playwright/apps-${width}.png` })
    const overflow = await page.getByRole('dialog').evaluate(el => el.scrollWidth > el.clientWidth + 1); assert(!overflow, 'Settings fit viewport')
    await page.getByRole('button', { name: 'Close settings', exact: true }).click()
    if (width === 390) await page.getByRole('button', { name: 'Close server navigation', exact: true }).click()
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('/ping')
    await page.getByRole('button', { name: '/ping · Ping Bot renamed', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByText('Pong!', { exact: true }).waitFor()
    assert.equal(posts.length, 1); assert.equal(posts[0].appId, apps[0].id)
    assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), '')
    failNext = true
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('/ping')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByText('The app failed to respond after five attempts', { exact: true }).waitFor()
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('/does-not-exist')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByText('This command is unavailable in this channel', { exact: false }).waitFor()
    assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), '/does-not-exist', 'Failed command retains its draft')
    await page.screenshot({ path: `output/playwright/commands-${width}.png` })
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('')
    apps[0].name = 'App changed in another client'
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('/')
    await page.getByRole('button', { name: '/ping · App changed in another client', exact: true }).waitFor()
    if (width === 390) await page.getByRole('button', { name: 'Open channels', exact: true }).click()
    await page.locator('.server-heading').click()
    await page.getByRole('menuitem', { name: 'Server Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Apps & integrations', exact: true }).click()
    await page.getByRole('button', { name: 'Uninstall', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm uninstall', exact: true }).click()
    await page.getByText(/No apps installed yet/).waitFor(); assert.equal(apps.length, 0)
    await page.getByRole('button', { name: 'Close settings', exact: true }).click()
    await page.locator('.server-heading').click()
    await page.getByRole('menuitem', { name: 'Installation Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Integrations', exact: true }).click()
    await page.getByRole('checkbox', { name: 'Allow server owners to install and run apps', exact: true }).uncheck()
    await page.getByLabel('Approved event origins', { exact: true }).fill('https://hooks.example.com')
    await page.getByRole('button', { name: 'Save app policy', exact: true }).click()
    await page.getByText('App policy saved. Pending deliveries were cancelled.', { exact: true }).waitFor()
    assert.deepEqual(policy, { enabled: false, allowedOrigins: ['https://hooks.example.com'] })
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`PASS ${width}px: generated client app install/configure/rotate/disable/uninstall, permissions, slash command discovery/send, errors and draft retention`)
  }
} finally { await browser.close(); await new Promise(r => server.close(r)) }

import { defaultPermissions } from '../runtime/contracts.mjs'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'

// Called by the real generated-client harness. All API identities are synthetic.
export async function invitationSettingsChecks(browser, base, build, signed, launch, member) {
  const token = 'a'.repeat(48), expired = 'b'.repeat(48), banned = 'c'.repeat(48)
  const methods = { passwordLogin: true, registration: true, telegramLogin: true, miniAppLogin: true }
  async function fixture({ role = 'member', authenticated = true, width = 390, remote = false } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block' })
    const page = await context.newPage(), user = { ...member, role, avatarUrl: null }
    const state = { authenticated, signedIn: 0, accepted: [], previews: [], joined: false, ownerReads: 0, logouts: 0 }
    await page.addInitScript(remote => {
      delete Navigator.prototype.serviceWorker
      if (remote) {
        localStorage.setItem('anycord-connections', JSON.stringify([{ origin: 'https://remote.example', name: 'Remote' }]))
        localStorage.setItem('anycord-active-connection', 'https://remote.example')
        sessionStorage.setItem('anycord-session:https://remote.example', 'fixture-remote-session')
      }
    }, remote)
    await page.route('https://telegram.org/js/telegram-web-app.js', route => route.fulfill({ contentType: 'text/javascript', body: `
      window.Telegram = { WebApp: { ready() {}, setHeaderColor() {}, setBackgroundColor() {} } };
      document.documentElement.style.setProperty('--tg-safe-area-inset-top', '44px');
      document.documentElement.style.setProperty('--tg-content-safe-area-inset-top', '56px');
      document.documentElement.style.setProperty('--tg-safe-area-inset-bottom', '34px');
    ` }))
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname
      let body = {}, status = 200
      if (path === '/api/runtime') body = { apiVersion: 1, engine: 'cloudflare', auth: 'better-auth', realtime: 'websocket', build }
      else if (path === '/api/auth/status') body = { initialized: true, user: state.authenticated ? user : null, methods }
      else if (path === '/api/auth/telegram/miniapp') {
        assert.equal(request.postDataJSON().initData, signed); state.signedIn++; state.authenticated = true
      } else if (path === '/api/account/telegram/profile') body = user
      else if (path === '/api/auth/logout') { state.authenticated = false; state.logouts++; body = { success: true } }
      else if (path === '/api/invitations/preview') {
        state.previews.push({ origin: url.origin, token: request.postDataJSON().token, authorization: request.headers().authorization })
        if (request.postDataJSON().token === expired) { status = 404; body = { message: 'Invitation expired or unavailable' } }
        else body = { name: 'Travel friends', initials: 'TF' }
      } else if (path === '/api/invitations/accept') {
        state.accepted.push({ origin: url.origin, token: request.postDataJSON().token, authorization: request.headers().authorization })
        if (request.postDataJSON().token === banned) { status = 403; body = { message: 'You are banned from this server' } }
        else { state.joined = true; body = { workspaceId: 'private' } }
      } else if (path === '/api/bootstrap') {
        const workspaceId = url.searchParams.get('workspace') || 'main'
        body = { user, workspaces: [{ id: 'main', name: 'Anycord', initials: 'AN', role: 'member', permissions: defaultPermissions }, ...(state.joined ? [{ id: 'private', name: 'Travel friends', initials: 'TF', role: 'member', permissions: defaultPermissions }] : [])], channels: [{ id: 'general', workspaceId, name: 'general', kind: 'text', topic: '', permissions: defaultPermissions }], members: [] }
      } else if (path.endsWith('/messages')) body = []
      else if (path === '/api/installation/authentication') { state.ownerReads++; body = methods }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    })
    return { context, page, state }
  }

  // Discoverable paste flow, no second login, explicit acceptance, refreshed picker.
  {
    const { context, page, state } = await fixture({ authenticated: false })
    await page.goto(base + '/servers#' + launch, { waitUntil: 'networkidle' })
    await page.getByRole('link', { name: 'Join a server', exact: true }).click()
    assert.equal(state.signedIn, 1)
    await page.getByLabel('Invitation link or code').fill(`https://other.example/invite#token=${token}`)
    await page.getByRole('button', { name: 'Check invitation', exact: true }).click()
    await page.getByText(/This invitation belongs to other.example/).waitFor()
    assert.equal(state.previews.length, 0, 'foreign capabilities must not reach the selected API')
    await page.getByLabel('Invitation link or code').fill(base + '/invite#token=' + expired)
    await page.getByRole('button', { name: 'Check invitation', exact: true }).click()
    await page.getByText('Invitation expired or unavailable', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Join as ' + member.name, exact: true }).count(), 0)
    await page.getByRole('button', { name: 'Use another invitation' }).click()
    await page.getByLabel('Invitation link or code').fill(banned)
    await page.getByRole('button', { name: 'Check invitation', exact: true }).click()
    await page.getByRole('button', { name: 'Join as ' + member.name, exact: true }).click()
    await page.getByText('You are banned from this server', { exact: true }).waitFor()
    assert.equal(new URL(page.url()).pathname, '/join')
    await page.getByRole('button', { name: 'Use another invitation' }).click()
    await page.getByLabel('Invitation link or code').fill(base + '/invite#token=' + token)
    await page.getByRole('button', { name: 'Check invitation', exact: true }).click()
    await page.getByRole('heading', { name: 'Travel friends', exact: true }).waitFor()
    assert.equal(state.accepted.length, 1, 'preview must never accept implicitly')
    await page.getByText(`Installation: ${new URL(base).host}`, { exact: true }).waitFor()
    if (process.env.ANYCORD_UI_CAPTURE) {
      await mkdir('output/playwright', { recursive: true })
      await page.screenshot({ path: 'output/playwright/invitation-preview-390.png', fullPage: true })
    }
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Join as ' + member.name, exact: true }).click()
    await page.waitForURL(url => url.pathname.startsWith('/private'))
    assert.equal(state.signedIn, 1, 'joining and reload must reuse the same Mini App account')
    assert.deepEqual(state.accepted.map(item => item.token), [banned, token])
    assert.equal(await page.evaluate(() => sessionStorage.getItem('anycord:pending-invitation')), null)
    await page.goto(base + '/servers', { waitUntil: 'networkidle' })
    await page.getByRole('link', { name: 'Travel friends Open server' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Installation Settings', exact: true }).count(), 0)
    assert.equal(state.ownerReads, 0, 'members must not request owner settings')
    await context.close()
    console.log('PASS Mini App paste: account reuse, preview, foreign/expired/banned links, explicit joining and refreshed membership')
  }

  // Incoming launch fragments and Telegram startapp preserve the invitation.
  for (const entry of [
    '/invite#' + launch + '&token=' + token,
    '/servers#' + launch + '&tgWebAppStartParam=invite_' + token,
  ]) {
    const { context, page, state } = await fixture({ authenticated: false, remote: true })
    await page.goto(base + entry, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Join as ' + member.name, exact: true }).waitFor()
    assert.equal(state.signedIn, 1, 'invitation resolves the serving installation’s Mini App account')
    assert.equal(state.accepted.length, 0)
    assert.equal(state.previews[0].origin, base)
    assert.equal(state.previews[0].authorization, undefined, 'remote credentials must never be forwarded to the invitation origin')
    assert(!page.url().includes('token') && !page.url().includes('tgWebAppData'))
    await page.getByRole('button', { name: 'Join as ' + member.name, exact: true }).click()
    await page.waitForURL(url => url.pathname.startsWith('/private'))
    await context.close()
  }
  console.log('PASS direct and startapp invitations preserve destination through Mini App authentication and select the serving installation')

  // Paste into a remote connection uses its own bearer session and pending token.
  {
    const { context, page, state } = await fixture({ remote: true })
    await page.goto(base + '/join', { waitUntil: 'networkidle' })
    await page.getByLabel('Invitation link or code').fill('https://remote.example/invite#token=' + token)
    await page.getByRole('button', { name: 'Check invitation', exact: true }).click()
    await page.getByRole('button', { name: 'Join as ' + member.name, exact: true }).waitFor()
    assert.equal(await page.evaluate(() => sessionStorage.getItem('anycord:pending-invitation')), null)
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Join as ' + member.name, exact: true }).click()
    await page.waitForURL(url => url.pathname.startsWith('/private'))
    assert.deepEqual(state.accepted, [{ origin: 'https://remote.example', token, authorization: 'Bearer fixture-remote-session' }])
    await context.close()
    console.log('PASS remote invitation: independent destination, bearer session and pending capability')
  }

  // One settings modal: repeated scope switches, close, Escape and focus return.
  for (const width of [390, 1280]) {
    const { context, page, state } = await fixture({ role: 'owner', width })
    await page.goto(base + '/servers#' + launch, { waitUntil: 'networkidle' })
    const trigger = page.getByRole('button', { name: 'User Settings', exact: true })
    await trigger.click()
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.getByRole('button', { name: 'Installation Settings', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Installation Settings', exact: true })
      await dialog.waitFor()
      assert.equal(await page.getByRole('dialog').count(), 1, 'scope navigation must keep exactly one dialog')
      await page.waitForFunction(() => document.activeElement?.textContent === 'Installation Settings')
      await page.getByText(/Changes apply to every community on this installation/).last().waitFor()
      const close = await page.getByRole('button', { name: 'Close settings', exact: true }).boundingBox()
      assert(close.y >= 100 && close.x >= 0 && close.x + close.width <= width && close.y + close.height <= 810, 'close stays inside Telegram safe areas')
      await page.keyboard.press('Tab')
      assert(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), 'focus stays inside settings')
      if (cycle === 0 && process.env.ANYCORD_UI_CAPTURE) {
        await mkdir('output/playwright', { recursive: true })
        await page.screenshot({ path: `output/playwright/installation-settings-${width}.png` })
      }
      await page.getByRole('button', { name: 'Back to User Settings', exact: true }).click()
      await page.getByRole('heading', { name: 'My Account', exact: true }).waitFor()
      assert.equal(await page.getByRole('dialog').count(), 1)
    }
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.waitForFunction(() => document.activeElement?.textContent === 'User Settings')
    await trigger.click()
    await page.getByRole('button', { name: 'Installation Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Close settings', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.waitForFunction(() => document.activeElement?.textContent === 'User Settings')
    await page.getByRole('button', { name: 'Installation Settings', exact: true }).click()
    await page.getByRole('dialog', { name: 'Installation Settings', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.goto(base + '/main/general', { waitUntil: 'networkidle' })
    if (width === 390) await page.getByRole('button', { name: 'Open channels', exact: true }).click()
    const accountTrigger = page.getByRole('button', { name: 'Open your account', exact: true })
    await accountTrigger.click()
    await page.getByRole('button', { name: 'Installation Settings', exact: true }).click()
    await page.getByRole('dialog', { name: 'Installation Settings', exact: true }).waitFor()
    assert.equal(await page.getByRole('dialog').count(), 1)
    await page.getByRole('button', { name: 'Back to User Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Close settings', exact: true }).click()
    await page.getByRole('dialog', { name: 'User Settings', exact: true }).waitFor({ state: 'hidden' })
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Open your account')
    await page.locator('.server-heading').click()
    await page.getByRole('menuitem', { name: 'Installation Settings', exact: true }).click()
    await page.getByRole('dialog', { name: 'Installation Settings', exact: true }).waitFor()
    assert.equal(await page.getByRole('dialog').count(), 1)
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: 'Installation Settings', exact: true }).waitFor({ state: 'hidden' })
    await page.locator('.server-heading').click()
    await page.getByRole('menuitem', { name: 'Join a server', exact: true }).click()
    await page.getByLabel('Invitation link or code').waitFor()
    await page.getByRole('button', { name: 'Back to servers', exact: true }).click()
    await trigger.click()
    await page.locator('.account-session').getByRole('button', { name: 'Log Out', exact: true }).click()
    await page.getByRole('heading', { name: 'Welcome back.', exact: true }).waitFor()
    assert.equal(state.logouts, 1, 'picker logout must revoke the session')
    assert.equal(state.signedIn, 0, 'explicit logout must not sign back in from the launch')
    await context.close()
    console.log(`PASS ${width}px settings: one modal, repeated scope navigation, safe close/Escape, focus return, owner entry and logout`)
  }
}

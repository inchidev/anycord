import { handleAppManagement, incomingSlackWebhook, incomingAppMessage, commandRegistry, invokeCommand, invocationResult, flushAppEvents } from './apps'
import { requirePermission, serverAccess, initializeRoles, permissionsView, type PermissionMutation } from './permissions'
import { roleInputSchema, memberRolesInputSchema, overridesInputSchema } from '../shared/contracts'
import { z, ZodError } from 'zod'
import { operatorRoute, operationsStatus, queueOperation, cancelOperation, updateBackupPolicy, migrationWriter } from './installation-operations'
import { maintenanceActive } from './maintenance'
import { publishedRelease } from './releases'
import { inviteTokenSchema, inviteInputSchema, recoveryResetSchema, passwordProofSchema } from '../shared/contracts'
import { generateRecoveryKeys, resetWithRecoveryKey, randomToken, previewInvite, acceptInvite } from './access'
import { and, eq, sql, desc, inArray } from 'drizzle-orm'
import * as tables from '../db/schema'
import { channelSchema, credentialsSchema, editMessageSchema, integrationSchema, messageSchema, reactionSchema, threadCreateSchema, workspaceSchema, workspaceUpdateSchema, channelUpdateSchema } from '../shared/contracts'
import { API_VERSION, matchEndpoint, matchLivePath } from '../shared/api'
import type { LiveEvent, User } from '../shared/contracts'
import { currentIdentity, currentUser, requireUser } from './auth'
import { createAuth, ensureProfile, revokeLiveSession } from './better-auth'
import { database, getMessages, getSetting, getThreads, requireChannel, requireMembership, requireThread, setSetting } from './store'
import { decrypt, digest, encrypt, equalSecret, HttpError, readBody } from './security'
import { applyMigrations, seedDatabase } from './migrate'
import migrations from './migrations.json'
import buildInfo from '../shared/build-info.json'
import { attachmentContent, cleanupAttachments, createAttachment, deleteAttachment, downloadAttachment, storageStatus, testStorage, updateStorage, uploadAttachment } from './storage'
import { askAI, testAI, integrationStatus, leaveHuddle, realtimeRequest } from './services'
import { authenticationConfig, authenticationStatus, authenticationMethods, initialized, updateAuthentication, telegramStatus, updateTelegramIntegration, configureTelegramWebhook } from './authentication'
import { authenticationInputSchema, telegramIntegrationInputSchema, telegramPreferencesInputSchema } from '../shared/contracts'
import { telegramAccount, updateTelegramPreferences, unlinkTelegram, telegramWebhook, queueTelegramNotifications, flushTelegramNotifications, testTelegramNotification } from './telegram-notifications'
import { authAccounts, authUsers } from '../db/auth-schema'
import { safeNext } from '../shared/navigation'
import { profileColumns, publicProfileName, telegramProfileJoin, applyTelegramProfile, userProfile } from './user-profiles'
import { verifyMiniAppData, miniAppProfile } from './telegram-plugin'

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
const hub = (env: Env, workspaceId: string) => env.HUBS.getByName(workspaceId)
async function publish(env: Env, workspaceId: string, event: LiveEvent) {
  // D1 is the source of truth. A failed notification never rolls back an acknowledged write.
  try { await hub(env, workspaceId).emit(event) } catch { console.warn(JSON.stringify({ event: 'broadcast_failed', workspaceId })) }
}
async function route(request: Request, env: Env, engine: 'celld' | 'cloudflare', ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url), path = url.pathname, method = request.method
  if (!path.startsWith('/api/')) {
    const response = await env.ASSETS.fetch(request)
    // celld's asset server can redirect generated page directories to a trailing
    // slash and then return 404. Serve the SPA shell for extensionless routes.
    if (engine === 'celld' && response.status === 404 && !path.split('/').filter(Boolean).at(-1)?.includes('.')) return env.ASSETS.fetch(new Request(new URL('/', request.url), request))
    return response
  }
  if (path.startsWith('/api/compat/slack/services/')) return incomingSlackWebhook(env, request)
  const endpoint = matchEndpoint(method, path)
  if (path.startsWith('/api/_operations/')) return operatorRoute(request, env, engine)
  if (endpoint?.name === 'runtime') return json({ apiVersion: API_VERSION, engine, auth: 'better-auth', realtime: 'websocket', build: buildInfo })
  if (path === '/api/_runtime') return json({ ok: true })
  if (path.startsWith('/api/compat/slack/services/')) return incomingSlackWebhook(env, request)
  if (!['/api/health', '/api/auth/status', '/api/_migrate'].includes(path) && !path.startsWith('/api/installation/operations') && await maintenanceActive(env)) throw new HttpError(503, 'Installation maintenance is in progress. Your draft is kept; try again when it finishes.')
  if (path === '/api/_migrate' && method === 'POST') {
    if (!env.MIGRATION_TOKEN || !await equalSecret(request.headers.get('X-Migration-Token') || '', env.MIGRATION_TOKEN)) throw new HttpError(403, 'Migration access denied')
    const input = z.object({ target: z.string().optional(), legacy: z.array(z.object({ id: z.string(), name: z.string(), text: z.string(), sentAt: z.number() })).max(100).optional() }).parse(await readBody(request, 1_000_000))
    const write = await maintenanceActive(env) ? await migrationWriter(env) : undefined
    const result = await applyMigrations(env.DB, input.target, write)
    await seedDatabase(env.DB, input.legacy, write)
    return json({ ...result, messageCount: (await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first<{ n: number }>())?.n })
  }
  if (path === '/api/_maintenance' && method === 'POST') {
    if (!env.MIGRATION_TOKEN || !await equalSecret(request.headers.get('X-Migration-Token') || '', env.MIGRATION_TOKEN)) throw new HttpError(403, 'Maintenance access denied')
    await cleanupAttachments(env); return json({ ok: true })
  }
  if (path === '/api/health') {
    try {
      const latest = await env.DB.prepare('SELECT name FROM app_migrations ORDER BY name DESC LIMIT 1').first<{ name: string }>()
      const ok = latest?.name === migrations.at(-1)?.name
      return json({ ok, runtime: engine, storage: 'D1', schema: latest?.name || null, build: buildInfo }, ok ? 200 : 503)
    } catch { return json({ ok: false, message: 'Database migrations are starting' }, 503) }
  }
  if (path === '/api/telegram/webhook' && method === 'POST') {
    const config = await authenticationConfig(env)
    if (!config.botToken || !config.webhookSecret || !await equalSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '', config.webhookSecret)) throw new HttpError(403, 'Invalid Telegram webhook secret')
    await telegramWebhook(env, await readBody(request))
    return json({ ok: true })
  }
  const contentId = path.match(/^\/api\/attachments\/([a-f0-9-]+)\/content$/)?.[1]
  if (contentId && method === 'GET') return attachmentContent(env, contentId, request)
  const origin = request.headers.get('Origin')
  const ticketWorkspace = matchLivePath(path), ticket = url.searchParams.get('ticket')
  if (ticketWorkspace && ticket && method === 'GET') {
    if (!/^[a-f0-9]{64}$/.test(ticket)) throw new HttpError(401, 'Invalid live connection ticket')
    const saved = await env.DB.prepare('DELETE FROM live_tickets WHERE hash = ? RETURNING authorization, origin, workspace_id, expires_at').bind(await digest(ticket)).first<{ authorization: string; origin: string; workspace_id: string; expires_at: number }>()
    if (!saved || saved.expires_at < Date.now() || saved.workspace_id !== ticketWorkspace || saved.origin !== origin) throw new HttpError(401, 'Live connection ticket expired')
    const headers = new Headers(request.headers); headers.delete('cookie'); headers.set('Authorization', await decrypt(saved.authorization, env.APP_SECRET))
    request = new Request(request, { headers })
  }
  const foreign = !!origin && origin !== url.origin
  const oidcCallback = path === '/api/auth/callback/telegram' && method === 'GET'
  const explicitLogin = endpoint?.name === 'connectionLogin' || endpoint?.name === 'authStatus' || oidcCallback
  if ((foreign || request.headers.get('Sec-Fetch-Site') === 'cross-site') && !explicitLogin && !request.headers.get('Authorization')?.startsWith('Bearer ')) throw new HttpError(403, 'Remote connections require explicit sign in')
  if (foreign || request.headers.has('Authorization')) {
    const headers = new Headers(request.headers); headers.delete('cookie')
    request = new Request(request, { headers })
  }
  if (endpoint) endpoint.spec.query.parse(Object.fromEntries(url.searchParams))
  const db = database(env)
  if (endpoint?.name === 'invitePreview') {
    const input = inviteTokenSchema.parse(await readBody(request))
    if (!await hub(env, '_auth').consumeRate(`invite-preview:${request.headers.get('CF-Connecting-IP') || 'local'}`, 30)) throw new HttpError(429, 'Try again in a minute')
    const invite = await previewInvite(env, input.token)
    return json({ name: invite.name, initials: invite.initials })
  }
  if (endpoint?.name === 'recoveryReset') {
    const input = recoveryResetSchema.parse(await readBody(request))
    if (!await hub(env, '_auth').consumeRate(`recovery:${input.name.toLowerCase()}`, 5) || !await hub(env, '_auth').consumeRate(`recovery-ip:${request.headers.get('CF-Connecting-IP') || 'local'}`, 15)) throw new HttpError(429, 'Too many recovery attempts. Try again in a minute.')
    await resetWithRecoveryKey(env, input.name, input.recoveryKey, input.password)
    return json({ ok: true })
  }
  if (endpoint?.name === 'authStatus') {
    const initialized = !!await db.select({ id: tables.users.id }).from(tables.users).where(eq(tables.users.role, 'owner')).get()
    if (request.headers.get('cookie')?.includes('cellcord_session=')) {
      const response = await createAuth(env).api.migrateLegacySession({ headers: request.headers, asResponse: true })
      const migration = await response.json() as { migrated: boolean; user: User | null }
      if (migration.migrated) return Response.json({ initialized, user: migration.user, methods: await authenticationStatus(env) }, { headers: response.headers })
    }
    return json({ initialized, setupRequired: !initialized && !!env.SETUP_TOKEN, user: await currentUser(request, env), methods: await authenticationStatus(env) })
  }
  if (endpoint?.name === 'authRegister' || endpoint?.name === 'authLogin' || endpoint?.name === 'connectionLogin') {
    const policy = await authenticationConfig(env)
    if (await initialized(env) && (!policy.passwordLogin || (endpoint.name === 'authRegister' && !policy.registration))) throw new HttpError(403, endpoint.name === 'authRegister' ? 'Registration is closed on this installation' : 'Password login is disabled on this installation')
    const input = credentialsSchema.parse(await readBody(request))
    if (endpoint.name === 'authRegister' && env.SETUP_TOKEN && !await db.select({ id: tables.users.id }).from(tables.users).where(eq(tables.users.role, 'owner')).get() && !await equalSecret(input.setupCode || '', env.SETUP_TOKEN)) throw new HttpError(403, 'Enter the installation setup code to create the first account')
    const name = input.name.toLowerCase()
    if (!await hub(env, '_auth').consumeRate(`auth:${name}`, 15)) throw new HttpError(429, 'Too many attempts. Try again in a minute.')
    const auth = createAuth(env)
    const authHeaders = endpoint.name === 'connectionLogin' ? new Headers({ Origin: env.AUTH_BASE_URL }) : request.headers
    const response = endpoint.name === 'authRegister'
      ? await auth.api.signUpEmail({ body: { name, username: name, email: `${crypto.randomUUID()}@local.cellcord.invalid`, password: input.password }, headers: authHeaders, asResponse: true })
      : await auth.api.signInUsername({ body: { username: name, password: input.password }, headers: authHeaders, asResponse: true })
    const result = await response.json() as { user?: { id: string; name: string }; message?: string }
    if (endpoint.name === 'connectionLogin' && (!response.ok || !result.user)) return json({ message: result.message || 'Could not sign in' }, response.status)
    if (!response.ok || !result.user) return Response.json({ message: result.message || 'Could not sign in' }, { status: response.status, headers: response.headers })
    const user = await ensureProfile(env, result.user)
    if (endpoint.name === 'connectionLogin') {
      const token = response.headers.get('set-auth-token')
      if (!token) throw new HttpError(500, 'Could not create remote session')
      return json({ token, user })
    }
    if (endpoint.name === 'authRegister') await publish(env, 'main', { type: 'refresh' })
    return Response.json({ user }, { status: endpoint.name === 'authRegister' ? 201 : 200, headers: response.headers })
  }
  if (path.startsWith('/api/auth/')) {
    if (path === '/api/auth/telegram/miniapp' && method === 'POST') {
      if (foreign || origin !== url.origin) throw new HttpError(403, 'Open the Mini App on this installation')
      if (!await hub(env, '_auth').consumeRate(`telegram:${request.headers.get('CF-Connecting-IP') || 'local'}`, 20)) throw new HttpError(429, 'Too many Telegram login attempts')
      const input = z.object({ initData: z.string().min(1).max(16_000), link: z.boolean().default(false) }).parse(await readBody(request))
      return createAuth(env).handler(new Request(request.url, { method, headers: request.headers, body: JSON.stringify(input) }))
    }
    if (oidcCallback || (['/api/auth/sign-in/social', '/api/auth/link-social'].includes(path) && method === 'POST')) {
      const config = await authenticationConfig(env)
      if (!authenticationMethods(config).telegramLogin || !await initialized(env)) throw new HttpError(403, 'Telegram browser login is unavailable')
      if (!oidcCallback) {
        if (foreign || origin !== url.origin) throw new HttpError(403, 'Open Telegram login on this installation')
        if (!await hub(env, '_auth').consumeRate(`telegram:${request.headers.get('CF-Connecting-IP') || 'local'}`, 20)) throw new HttpError(429, 'Too many Telegram login attempts')
        const linking = path === '/api/auth/link-social'
        const current = await currentUser(request, env)
        if (linking && !current) throw new HttpError(401, 'Sign in before linking Telegram')
        if (!linking && current) throw new HttpError(409, 'Already signed in. Link Telegram in User Settings.')
        if (linking && await db.select().from(authAccounts).where(and(eq(authAccounts.userId, current!.id), eq(authAccounts.providerId, 'telegram'))).get()) throw new HttpError(409, 'Telegram is already linked. Unlink it before changing accounts.')
        const input = z.object({ provider: z.literal('telegram'), callbackURL: z.string().max(2048).optional() }).parse(await readBody(request))
        const body = { provider: input.provider, callbackURL: new URL(safeNext(input.callbackURL), env.AUTH_BASE_URL).href,
          errorCallbackURL: new URL('/login?telegram=error', env.AUTH_BASE_URL).href, disableRedirect: true }
        return createAuth(env, config).handler(new Request(request.url, { method, headers: request.headers, body: JSON.stringify(body) }))
      }
      return createAuth(env, config).handler(request)
    }
    if ((path === '/api/auth/logout' || path === '/api/auth/sign-out') && method === 'POST') {
      const auth = createAuth(env)
      const session = await auth.api.getSession({ headers: request.headers })
      const logoutHeaders = new Headers(request.headers)
      if (logoutHeaders.has('Authorization')) { logoutHeaders.set('Origin', env.AUTH_BASE_URL); logoutHeaders.delete('Sec-Fetch-Site') }
      const response = await auth.api.signOut({ headers: logoutHeaders, asResponse: true })
      if (response.ok && session) await revokeLiveSession(env, session.session.token, session.user.id)
      return response
    }
    const allowed = ['/api/auth/sign-in/username', '/api/auth/sign-out', '/api/auth/get-session', '/api/auth/is-username-available', '/api/auth/migrate-legacy-session']
    if (!allowed.includes(path)) throw new HttpError(404, 'Not found')
    if (path === '/api/auth/sign-in/username' && method === 'POST') {
      if (!(await authenticationConfig(env)).passwordLogin) throw new HttpError(403, 'Password login is disabled on this installation')
      const input = z.object({ username: z.string().min(2).max(32), password: z.string().max(128) }).passthrough().parse(await readBody(request))
      if (!await hub(env, '_auth').consumeRate(`auth:${input.username.toLowerCase()}`, 15)) throw new HttpError(429, 'Too many attempts. Try again in a minute.')
      return createAuth(env).handler(new Request(request.url, { method, headers: request.headers, body: JSON.stringify(input) }))
    }
    return createAuth(env).handler(request)
  }
  if (endpoint?.name === 'appPost') return incomingAppMessage(env, endpoint.params.appId!, request)
  const user = await requireUser(request, env)
  if (endpoint && ['operations','operationCreate','operationCancel','backupPolicyUpdate','installationRelease','restoredIntegrations'].includes(endpoint.name)) {
    if (user.role !== 'owner') throw new HttpError(403, 'Only the installation owner can manage backups and updates')
    if (endpoint.name === 'operations') return json(await operationsStatus(env, engine))
    if (endpoint.name === 'operationCreate') return json(await queueOperation(env, engine, user.id, await readBody(request)))
    if (endpoint.name === 'operationCancel') return json(await cancelOperation(env, endpoint.params.jobId!))
    if (endpoint.name === 'backupPolicyUpdate') return json(await updateBackupPolicy(env, await readBody(request)))
    if (endpoint.name === 'installationRelease') return json(await publishedRelease(engine))
    z.object({ enable: z.literal(true) }).parse(await readBody(request))
    await env.DB.batch([env.DB.prepare('UPDATE installation_state SET outbound_disabled=0 WHERE id=1'), env.DB.prepare("DELETE FROM settings WHERE key='restored_outbound_disabled'")])
    return json({ ok: true })
  }
  if (!['GET', 'HEAD'].includes(method) && !await hub(env, '_auth').consumeRate(`writes:${user.id}`, 90)) throw new HttpError(429, 'You are sending too quickly. Try again in a minute.')
  if (endpoint) {
    const appResponse = await handleAppManagement(env, user, endpoint.name, endpoint.params, request)
    if (appResponse) return appResponse
    if (endpoint.name === 'commands') return json(await commandRegistry(env, user, endpoint.params.channelId!))
    if (endpoint.name === 'commandInvoke') {
      const response = await invokeCommand(env, user, endpoint.params.channelId!, request)
      ctx.waitUntil(flushAppEvents(env))
      return response
    }
    if (endpoint.name === 'commandResult') return json(await invocationResult(env, user, endpoint.params.channelId!, endpoint.params.invocationId!))
  }
  if (endpoint?.name === 'recoveryStatus') {
    const row = await env.DB.prepare('SELECT COUNT(*) AS count, MAX(created_at) AS generatedAt FROM recovery_keys WHERE user_id = ? AND claim_id IS NULL').bind(user.id).first()
    return json(row)
  }
  if (endpoint?.name === 'recoveryGenerate') {
    if (!await hub(env, '_auth').consumeRate(`recovery-generate:${user.id}`, 5)) throw new HttpError(429, 'Try again in a minute')
    const input = passwordProofSchema.parse(await readBody(request))
    return json({ keys: await generateRecoveryKeys(env, user.id, input.password) })
  }
  if (endpoint?.name === 'inviteAccept') {
    const input = inviteTokenSchema.parse(await readBody(request))
    const workspaceId = await acceptInvite(env, user.id, input.token)
    await publish(env, workspaceId, { type: 'refresh' })
    return json({ workspaceId })
  }
  if (endpoint && ['invites', 'inviteCreate', 'inviteRevoke', 'memberRemove', 'memberBan', 'memberUnban', 'bans'].includes(endpoint.name)) {
    const workspaceId = endpoint.params.workspaceId!
    await requirePermission(env, user.id, workspaceId, endpoint.name === 'memberRemove' ? 'members.remove' : ['memberBan', 'memberUnban', 'bans'].includes(endpoint.name) ? 'members.ban' : 'invites.manage')
    if (endpoint.name === 'invites') return json(await db.select({ id: tables.invitations.id, createdAt: tables.invitations.createdAt, expiresAt: tables.invitations.expiresAt, maxUses: tables.invitations.maxUses, uses: tables.invitations.uses }).from(tables.invitations).where(eq(tables.invitations.workspaceId, workspaceId)).orderBy(desc(tables.invitations.createdAt)).all())
    if (endpoint.name === 'inviteCreate') {
      const input = inviteInputSchema.parse(await readBody(request))
      const token = randomToken(), createdAt = Date.now(), id = crypto.randomUUID(), expiresAt = createdAt + input.expiresInHours * 3600_000
      await db.insert(tables.invitations).values({ id, hash: await digest(token), workspaceId, createdBy: user.id, createdAt, expiresAt, maxUses: input.maxUses }).run()
      return json({ id, token, createdAt, expiresAt, maxUses: input.maxUses, uses: 0 }, 201)
    }
    if (endpoint.name === 'inviteRevoke') {
      await db.delete(tables.invitations).where(and(eq(tables.invitations.id, endpoint.params.inviteId!), eq(tables.invitations.workspaceId, workspaceId))).run()
      return json({ ok: true })
    }
    if (endpoint.name === 'bans') return json(await db.select({ id: tables.users.id, name: publicProfileName, createdAt: tables.workspaceBans.createdAt }).from(tables.workspaceBans).innerJoin(tables.users, eq(tables.workspaceBans.userId, tables.users.id)).leftJoin(authUsers, eq(authUsers.id, tables.users.id)).leftJoin(authAccounts, telegramProfileJoin).where(eq(tables.workspaceBans.workspaceId, workspaceId)).all())
    if (endpoint.name === 'memberUnban') {
      await db.delete(tables.workspaceBans).where(and(eq(tables.workspaceBans.workspaceId, workspaceId), eq(tables.workspaceBans.userId, endpoint.params.userId!))).run()
      return json({ ok: true })
    }
    const removed = await hub(env, workspaceId).removeMember(workspaceId, user.id, endpoint.params.userId!, endpoint.name === 'memberBan')
    if (!removed.ok) throw new HttpError(removed.status, removed.message)
    await publish(env, workspaceId, { type: 'refresh' })
    return json({ ok: true })
  }
  if (['authentication', 'authenticationUpdate', 'telegramIntegration', 'telegramIntegrationUpdate', 'telegramWebhookSetup'].includes(endpoint?.name || '')) {
    if (user.role !== 'owner') throw new HttpError(403, 'Only the installation owner can configure authentication and bot credentials')
    if (endpoint?.name === 'authentication') return json(await authenticationStatus(env))
    if (endpoint?.name === 'authenticationUpdate') return json(await updateAuthentication(env, user.id, authenticationInputSchema.parse(await readBody(request))))
    if (endpoint?.name === 'telegramIntegration') return json(telegramStatus(env, await authenticationConfig(env)))
    if (endpoint?.name === 'telegramIntegrationUpdate') return json(await updateTelegramIntegration(env, user.id, telegramIntegrationInputSchema.parse(await readBody(request))))
    await configureTelegramWebhook(env); return json({ ok: true })
  }
  if (endpoint?.name === 'telegramAccount') return json(await telegramAccount(env, user.id))
  if (endpoint?.name === 'telegramProfileSync') {
    const config = await authenticationConfig(env)
    if (!config.miniAppLogin || !config.botToken) throw new HttpError(403, 'Mini App profile sync is unavailable')
    const { initData } = endpoint.spec.body.parse(await readBody(request)) as { initData: string }
    let telegram
    try { telegram = await verifyMiniAppData(initData, config.botToken) }
    catch { throw new HttpError(401, 'Reopen the Mini App to refresh your Telegram profile') }
    const linked = await db.select().from(authAccounts).where(and(eq(authAccounts.userId, user.id), eq(authAccounts.providerId, 'telegram'), eq(authAccounts.accountId, String(telegram.id)))).get()
    if (!linked) throw new HttpError(403, 'This Telegram account is not linked to your account')
    if (!await hub(env, '_auth').consumeRate(`telegram-profile:${user.id}`, 15)) throw new HttpError(429, 'Please wait before refreshing your profile')
    await applyTelegramProfile(env, user.id, miniAppProfile(telegram))
    return json(await userProfile(env, user.id))
  }
  if (endpoint?.name === 'telegramPreferences') return json(await updateTelegramPreferences(env, user.id, telegramPreferencesInputSchema.parse(await readBody(request))))
  if (endpoint?.name === 'telegramUnlink') { await unlinkTelegram(env, user.id); return json({ ok: true }) }
  if (endpoint?.name === 'telegramTest') {
    if (!await hub(env, '_auth').consumeRate(`telegram-test:${user.id}`, 3)) throw new HttpError(429, 'Please wait before sending another test')
    await testTelegramNotification(env, user.id); return json({ ok: true })
  }
  if (endpoint?.name === 'accountPassword') {
    const auth = createAuth(env)
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session || Date.now() - new Date(session.session.createdAt).getTime() > 600_000) throw new HttpError(403, 'Sign in again before adding a password')
    const input = endpoint.spec.body.parse(await readBody(request)) as { username: string; password: string }
    if (!(await telegramAccount(env, user.id)).canSetPassword) throw new HttpError(409, 'This account already has a password')
    const username = input.username.toLowerCase()
    const taken = await db.select().from(authUsers).where(eq(authUsers.username, username)).get()
    const profileTaken = await db.select().from(tables.users).where(eq(tables.users.name, username)).get()
    if ((taken && taken.id !== user.id) || (profileTaken && profileTaken.id !== user.id)) throw new HttpError(409, 'Choose another username')
    // Reserve the login name first. If freshness/password validation fails, the
    // same account can retry without leaving an inaccessible credential behind.
    await db.batch([
      db.update(authUsers).set({ username }).where(eq(authUsers.id, user.id)),
      db.update(tables.users).set({ name: username }).where(eq(tables.users.id, user.id)),
    ])
    const response = await auth.api.setPassword({ headers: request.headers, body: { newPassword: input.password }, asResponse: true })
    if (!response.ok) return response
    return json({ ok: true })
  }
  if (endpoint?.name === 'liveTicket') {
    const authorization = request.headers.get('Authorization')
    if (!authorization?.startsWith('Bearer ') || !origin) throw new HttpError(400, 'Use a signed remote session with an origin')
    await requireMembership(env, user.id, endpoint.params.workspaceId!)
    const ticket = [...crypto.getRandomValues(new Uint8Array(32))].map(v => v.toString(16).padStart(2, '0')).join('')
    await database(env).insert(tables.liveTickets).values({ hash: await digest(ticket), authorization: await encrypt(authorization, env.APP_SECRET), workspaceId: endpoint.params.workspaceId!, origin, expiresAt: Date.now() + 30_000 }).run()
    return json({ ticket })
  }
  const uploadId = path.match(/^\/api\/attachments\/([a-f0-9-]+)\/upload$/)?.[1]
  if (uploadId && method === 'PUT') return json(await uploadAttachment(env, user, uploadId, request))
  if (endpoint?.name === 'attachmentDownload') return json(await downloadAttachment(env, user, endpoint.params.attachmentId!))
  if (endpoint?.name === 'attachmentDelete') return json(await deleteAttachment(env, user, endpoint.params.attachmentId!))
  if (endpoint?.name === 'storage') return json(await storageStatus(env))
  if (endpoint?.name === 'storageUpdate' || endpoint?.name === 'storageTest') {
    if (user.role !== 'owner') throw new HttpError(403, 'Only the installation owner can change file storage')
    return json(endpoint.name === 'storageTest' ? await testStorage(env) : await updateStorage(env, request))
  }
  if (endpoint?.name === 'permissions') return json(await permissionsView(env, user.id, endpoint.params.workspaceId!))
  if (endpoint?.name === 'audit') {
    const workspaceId = endpoint.params.workspaceId!
    await requirePermission(env, user.id, workspaceId, 'audit.view')
    return json(await db.select().from(tables.auditEvents).where(eq(tables.auditEvents.workspaceId, workspaceId)).orderBy(desc(tables.auditEvents.createdAt)).limit(100).all())
  }
  if (endpoint && ['roleCreate', 'roleUpdate', 'roleDelete', 'memberRolesUpdate', 'channelPermissions', 'channelPermissionsUpdate'].includes(endpoint.name)) {
    let workspaceId = endpoint.params.workspaceId!
    if (endpoint.params.channelId) {
      const channel = await requireChannel(env, user, endpoint.params.channelId)
      workspaceId = channel.workspaceId
      await requirePermission(env, user.id, workspaceId, 'channels.permissions', channel.id)
      if (endpoint.name === 'channelPermissions') return json({ overrides: await db.select().from(tables.channelOverrides).where(eq(tables.channelOverrides.channelId, channel.id)).all() })
    }
    let action: PermissionMutation
    if (endpoint.name === 'roleCreate') action = { kind: 'create', input: roleInputSchema.parse(await readBody(request)) }
    else if (endpoint.name === 'roleUpdate') action = { kind: 'update', roleId: endpoint.params.roleId!, input: roleInputSchema.parse(await readBody(request)) }
    else if (endpoint.name === 'roleDelete') action = { kind: 'delete', roleId: endpoint.params.roleId! }
    else if (endpoint.name === 'memberRolesUpdate') action = { kind: 'assign', userId: endpoint.params.userId!, input: memberRolesInputSchema.parse(await readBody(request)) }
    else action = { kind: 'overrides', channelId: endpoint.params.channelId!, input: overridesInputSchema.parse(await readBody(request)) }
    const result = await hub(env, workspaceId).mutatePermissions(workspaceId, user.id, action)
    if (!result.ok) throw new HttpError(result.status, result.message)
    return json(result.value, endpoint.name === 'roleCreate' ? 201 : 200)
  }
  if (endpoint?.name === 'bootstrap') {
    const spaces = await db.select({ id: tables.workspaces.id, name: tables.workspaces.name, initials: tables.workspaces.initials, role: tables.memberships.role })
      .from(tables.workspaces).innerJoin(tables.memberships, and(eq(tables.memberships.workspaceId, tables.workspaces.id), eq(tables.memberships.userId, user.id))).all()
    const workspaceId = url.searchParams.get('workspace') || spaces[0]?.id || 'main'
    const access = await serverAccess(env, user.id, workspaceId)
    const allChannels = await db.select().from(tables.channels).where(eq(tables.channels.workspaceId, workspaceId)).orderBy(tables.channels.position).all()
    const members = await db.select({ ...profileColumns, workspaceRole: tables.memberships.role }).from(tables.users)
      .leftJoin(authUsers, eq(authUsers.id, tables.users.id)).leftJoin(authAccounts, telegramProfileJoin)
      .innerJoin(tables.memberships, and(eq(tables.memberships.userId, tables.users.id), eq(tables.memberships.workspaceId, workspaceId))).all()
    const channels = allChannels.map(item => ({ ...item, permissions: access.channelPermissions(item.id) })).filter(item => item.permissions.includes('channels.view'))
    const assignments = await db.select().from(tables.memberRoles).where(eq(tables.memberRoles.workspaceId, workspaceId)).all()
    return json({ user, workspaces: spaces.map(space => space.id === workspaceId ? { ...space, permissions: access.permissions } : space), channels, members: members.map(member => ({ ...member, roleIds: assignments.filter(item => item.userId === member.id).map(item => item.roleId), highestRolePosition: member.workspaceRole === 'owner' ? 10001 : Math.max(0, ...access.roles.filter(role => assignments.some(item => item.userId === member.id && item.roleId === role.id)).map(role => role.position)) })) })
  }
  if (endpoint?.name === 'workspaceCreate') {
    if (user.role !== 'owner') throw new HttpError(403, 'Only the installation owner can create servers')
    const input = workspaceSchema.parse(await readBody(request))
    const id = crypto.randomUUID()
    await db.batch([
      db.insert(tables.workspaces).values({ id, name: input.name, initials: input.name.split(/\s+/).map((word) => word[0]).join('').slice(0, 3).toUpperCase() }),
      db.insert(tables.memberships).values({ userId: user.id, workspaceId: id, role: 'owner' }),
      db.insert(tables.channels).values({ id: crypto.randomUUID(), workspaceId: id, name: 'general', topic: 'The beginning of something good.', kind: 'text', position: 0 }),
    ])
    await initializeRoles(env, id)
    return json({ id }, 201)
  }
  if (endpoint?.name === 'workspaceUpdate') {
    const workspaceId = endpoint.params.workspaceId!
    const membership = await requireMembership(env, user.id, workspaceId)
    await requirePermission(env, user.id, workspaceId, 'server.manage')
    const input = workspaceUpdateSchema.parse(await readBody(request))
    const workspace = await db.update(tables.workspaces).set(input).where(eq(tables.workspaces.id, workspaceId)).returning().get()
    if (!workspace) throw new HttpError(404, 'Server not found')
    await publish(env, workspaceId, { type: 'refresh' })
    return json({ ...workspace, role: membership.role })
  }
  const socketWorkspace = matchLivePath(path)
  if (socketWorkspace && method === 'GET') {
    const workspaceId = socketWorkspace
    await requireMembership(env, user.id, workspaceId)
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'WebSocket upgrade required')
    const identity = await currentIdentity(request, env)
    if (!identity) throw new HttpError(401, 'Sign in to continue')
    const headers = new Headers(request.headers)
    headers.set('X-Cellcord-Identity', JSON.stringify({ userId: user.id, name: user.name, workspaceId, sessionHash: identity.sessionHash, expiresAt: identity.expiresAt, lastTyping: 0 }))
    return hub(env, workspaceId).fetch(new Request(request, { headers }))
  }
  if (endpoint?.name === 'channelCreate') {
    const workspaceId = endpoint.params.workspaceId!
    await requirePermission(env, user.id, workspaceId, 'channels.manage')
    const input = channelSchema.parse(await readBody(request)), id = crypto.randomUUID()
    await db.insert(tables.channels).values({ id, workspaceId, ...input, position: Date.now() }).run()
    await publish(env, workspaceId, { type: 'refresh' })
    return json({ id }, 201)
  }
  if (endpoint?.name === 'search') {
    const workspaceId = url.searchParams.get('workspace') || 'main'
    await requireMembership(env, user.id, workspaceId)
    const access = await serverAccess(env, user.id, workspaceId)
    const allChannels = await db.select({ id: tables.channels.id }).from(tables.channels).where(eq(tables.channels.workspaceId, workspaceId)).all()
    const visible = allChannels.filter(item => { const permissions = access.channelPermissions(item.id); return permissions.includes('channels.view') && permissions.includes('messages.read') }).map(item => item.id)
    if (!visible.length) return json([])
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100)
    if (!q) return json([])
    const searchRows = (ids?: string[]) => db.select({ id: tables.messages.id, text: tables.messages.text, channelId: tables.channels.id, channel: tables.channels.name, authorId: tables.users.id, author: publicProfileName, createdAt: tables.messages.createdAt, threadId: tables.messages.threadId })
      .from(tables.messages).innerJoin(tables.channels, eq(tables.channels.id, tables.messages.channelId)).innerJoin(tables.users, eq(tables.users.id, tables.messages.authorId))
      .leftJoin(authUsers, eq(authUsers.id, tables.users.id)).leftJoin(authAccounts, telegramProfileJoin)
      .where(and(eq(tables.channels.workspaceId, workspaceId), ids ? inArray(tables.channels.id, ids) : undefined, sql`instr(lower(${tables.messages.text}), lower(${q})) > 0`))
      .orderBy(desc(tables.messages.createdAt)).limit(40).all()
    const rows: Awaited<ReturnType<typeof searchRows>> = []
    if (visible.length === allChannels.length) rows.push(...await searchRows())
    else for (let i = 0; i < visible.length; i += 80) rows.push(...await searchRows(visible.slice(i, i + 80)))
    rows.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    return json(rows.slice(0, 40).map(({ authorId, ...row }) => ({ ...row, author: authorId === 'system' ? 'Anycord' : row.author })))
  }
  if (endpoint?.params.channelId) {
    const channelId = endpoint.params.channelId, item = endpoint.params.messageId || endpoint.params.participantId
    const channel = await requireChannel(env, user, channelId)
    const access = await serverAccess(env, user.id, channel.workspaceId)
    const permissions = access.channelPermissions(channelId)
    const require = (key: import('../shared/permissions').PermissionKey) => { if (!permissions.includes(key)) throw new HttpError(403, `Missing permission: ${key}`) }
    if (['messages', 'threads', 'thread', 'threadFollow', 'threadFollowUpdate', 'threadCreate', 'reactionToggle', 'aiAsk', 'messageCreate'].includes(endpoint.name)) require('messages.read')
    if (endpoint.name === 'threadFollow' || endpoint.name === 'threadFollowUpdate') {
      await requireThread(env, channelId, endpoint.params.threadId!)
      const key = and(eq(tables.threadFollowers.userId, user.id), eq(tables.threadFollowers.threadId, endpoint.params.threadId!))
      if (endpoint.name === 'threadFollowUpdate') {
        const input = z.object({ following: z.boolean() }).parse(await readBody(request))
        if (input.following) await db.insert(tables.threadFollowers).values({ userId: user.id, threadId: endpoint.params.threadId! }).onConflictDoNothing().run()
        else await db.delete(tables.threadFollowers).where(key).run()
      }
      return json({ following: !!await db.select().from(tables.threadFollowers).where(key).get() })
    }
    if (endpoint.name === 'attachmentCreate') return json(await createAttachment(env, user, channelId, request), 201)
    if (endpoint.name === 'channelUpdate') {
      require('channels.manage')
      const input = channelUpdateSchema.parse(await readBody(request))
      const updated = await db.update(tables.channels).set(input).where(eq(tables.channels.id, channelId)).returning().get()
      await publish(env, channel.workspaceId, { type: 'refresh', channelId })
      return json(updated)
    }
    if (endpoint.name === 'threads') return json(await getThreads(env, channelId))
    if (endpoint.name === 'thread') {
      const thread = await requireThread(env, channelId, endpoint.params.threadId!)
      return json({ thread, parent: thread.parentMessageId ? (await getMessages(env, channelId, user.id, thread.parentMessageId))[0] || null : null,
        messages: await getMessages(env, channelId, user.id, undefined, url.searchParams.get('focus') || undefined, thread.id) })
    }
    if (endpoint.name === 'threadCreate') {
      require('threads.create'); require('messages.send')
      if (channel.kind !== 'text') throw new HttpError(400, 'Choose a text channel first')
      const input = threadCreateSchema.parse(await readBody(request))
      const parent = await db.select().from(tables.messages).where(and(eq(tables.messages.id, input.parentMessageId), eq(tables.messages.channelId, channelId))).get()
      if (!parent || parent.threadId) throw new HttpError(404, 'Choose a message in this channel to start a thread')
      const byId = await db.select().from(tables.threads).where(eq(tables.threads.id, input.id)).get()
      if (byId && (byId.channelId !== channelId || byId.parentMessageId !== input.parentMessageId)) throw new HttpError(409, 'Thread ID already exists')
      const inserted = await db.insert(tables.threads).values({ ...input, channelId, authorId: user.id, createdAt: Date.now() }).onConflictDoNothing().returning({ id: tables.threads.id }).get()
      const thread = (await getThreads(env, channelId, undefined, [parent.id]))[0]
      if (!thread) throw new HttpError(409, 'Could not create this thread')
      if (inserted) await publish(env, channel.workspaceId, { type: 'refresh', channelId })
      return json(thread, inserted ? 201 : 200)
    }
    if (endpoint.name === 'messages') {
      const threadId = url.searchParams.get('threadId') || undefined
      if (threadId) await requireThread(env, channelId, threadId)
      return json(await getMessages(env, channelId, user.id, undefined, url.searchParams.get('focus') || undefined, threadId))
    }
    if (endpoint.name === 'messageCreate') {
      require('messages.send')
      if (channel.kind !== 'text') throw new HttpError(400, 'Choose a text channel to send messages')
      const input = messageSchema.parse(await readBody(request))
      const existing = await db.select().from(tables.messages).where(eq(tables.messages.id, input.id)).get()
      if (existing && (existing.authorId !== user.id || existing.channelId !== channelId || existing.threadId !== (input.threadId || null) || existing.replyToId !== (input.replyToId || null) || existing.text !== input.text)) throw new HttpError(409, 'Message ID already exists for a different message')
      if (!existing) {
        if (input.threadId) await requireThread(env, channelId, input.threadId)
        if (input.replyToId) {
          const parent = await db.select().from(tables.messages).where(and(eq(tables.messages.id, input.replyToId), eq(tables.messages.channelId, channelId))).get()
          if (!parent || parent.threadId !== (input.threadId || null)) throw new HttpError(404, 'Reply target is no longer available in this conversation')
        }
      }
      const fileIds = input.attachmentIds || []
      if (fileIds.length) require('attachments.upload')
      let inserted = false
      if (!existing) {
        if (fileIds.length) {
          const placeholders = fileIds.map(() => '?').join(',')
          const result = await env.DB.batch([
            env.DB.prepare(`INSERT INTO messages (id, channel_id, author_id, text, created_at, reply_to_id, thread_id) SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM attachments WHERE id IN (${placeholders}) AND channel_id = ? AND owner_id = ? AND status = 'uploaded' AND message_id IS NULL) = ? ON CONFLICT DO NOTHING`).bind(input.id, channelId, user.id, input.text, Date.now(), input.replyToId || null, input.threadId || null, ...fileIds, channelId, user.id, fileIds.length),
            env.DB.prepare(`UPDATE attachments SET message_id = ? WHERE changes() = 1 AND id IN (${placeholders}) AND message_id IS NULL AND status = 'uploaded' AND owner_id = ? AND channel_id = ?`).bind(input.id, ...fileIds, user.id, channelId),
          ])
          inserted = result[0]!.meta.changes > 0
          if (!inserted && !await db.select().from(tables.messages).where(eq(tables.messages.id, input.id)).get()) throw new HttpError(409, 'Some attachments are unavailable. Upload them again.')
        } else {
          const { attachmentIds, ...values } = input
          inserted = !!await db.insert(tables.messages).values({ ...values, authorId: user.id, channelId, createdAt: Date.now() }).onConflictDoNothing().returning({ id: tables.messages.id }).get()
        }
      }
      const message = (await getMessages(env, channelId, user.id, input.id))[0]
      if (!message) throw new HttpError(500, 'Could not load the saved message')
      if (message.authorId !== user.id || message.threadId !== (input.threadId || null) || message.replyToId !== (input.replyToId || null) || message.text !== input.text || JSON.stringify(message.attachments.map(f => f.id).sort()) !== JSON.stringify(fileIds.slice().sort())) throw new HttpError(409, 'Message ID already exists for a different message')
      if (inserted) {
        await publish(env, channel.workspaceId, { type: 'message', message })
        ctx.waitUntil(flushAppEvents(env))
        ctx.waitUntil(queueTelegramNotifications(env, channel.workspaceId, message).then(() => flushTelegramNotifications(env)).catch(() => { console.warn(JSON.stringify({ event: 'telegram_enqueue_failed' })) }))
      }
      return json(message, inserted ? 201 : 200)
    }
    if (item && ['messageEdit', 'messageDelete', 'reactionToggle'].includes(endpoint.name)) {
      const message = await db.select().from(tables.messages).where(and(eq(tables.messages.id, item), eq(tables.messages.channelId, channelId))).get()
      if (!message) throw new HttpError(404, 'Message not found')
      if (method === 'PATCH') {
        require('messages.send')
        if (message.authorId !== user.id) throw new HttpError(403, 'You can only edit your own messages')
        const input = editMessageSchema.parse(await readBody(request))
        await db.update(tables.messages).set({ text: input.text, editedAt: Date.now() }).where(eq(tables.messages.id, item)).run()
      } else if (method === 'DELETE') {
        if (message.authorId !== user.id) require('messages.manage')
        await db.delete(tables.messages).where(eq(tables.messages.id, item)).run()
      } else if (method === 'POST') {
        require('reactions.add')
        const input = reactionSchema.parse(await readBody(request))
        const condition = and(eq(tables.reactions.messageId, item), eq(tables.reactions.userId, user.id), eq(tables.reactions.emoji, input.emoji))
        const reaction = await db.select().from(tables.reactions).where(condition).get()
        if (reaction) await db.delete(tables.reactions).where(condition).run()
        else await db.insert(tables.reactions).values({ messageId: item, userId: user.id, emoji: input.emoji }).onConflictDoNothing().run()
      } else throw new HttpError(405, 'Method not allowed')
      await publish(env, channel.workspaceId, { type: 'refresh', channelId })
      return json({ ok: true })
    }
    if (endpoint.name === 'aiAsk') {
      require('ai.ask'); require('messages.send')
      if (channel.kind !== 'text') throw new HttpError(400, 'Choose a text channel first')
      if (!await hub(env, '_auth').consumeRate(`ai:${user.id}`, 3)) throw new HttpError(429, 'Please wait before asking AI again')
      const text = await askAI(env, channelId, user.id), id = crypto.randomUUID()
      await db.insert(tables.messages).values({ id, channelId, authorId: 'system', text, createdAt: Date.now() }).run()
      const message = (await getMessages(env, channelId, user.id, id))[0]
      if (!message) throw new HttpError(500, 'Could not load the AI response')
      await publish(env, channel.workspaceId, { type: 'message', message })
      return json(message)
    }
    if (endpoint.name === 'huddleJoin') {
      require('voice.connect')
      if (!await hub(env, '_auth').consumeRate(`huddle:${user.id}`, 8)) throw new HttpError(429, 'Please wait before joining again')
      const result = await hub(env, channel.workspaceId).joinHuddle(channel.id, channel.name, user)
      if (!result.ok) throw new HttpError(result.status, result.message)
      return json({ authToken: result.authToken, participantId: result.participantId, meetingId: result.meetingId })
    }
    if (endpoint.name === 'huddleLeave' && item) {
      await leaveHuddle(env, channelId, item, user.id)
      return json({ ok: true })
    }
  }
  if (endpoint?.name === 'integrations') return json(await integrationStatus(env))
  if (endpoint?.name === 'integrationsUpdate') {
    if (user.role !== 'owner') throw new HttpError(403, 'Only the installation owner can change API credentials')
    const input = integrationSchema.parse(await readBody(request))
    if ((input.realtimeAccountId && !/^[a-f0-9]{32}$/.test(input.realtimeAccountId)) || (input.realtimeAppId && !/^[a-zA-Z0-9-]+$/.test(input.realtimeAppId))) throw new HttpError(400, 'Check the account ID and app ID')
    const accountChanged = input.realtimeAccountId !== await getSetting(env, 'realtimeAccountId') || input.realtimeAppId !== await getSetting(env, 'realtimeAppId')
    if (accountChanged) {
      const active = await db.select().from(tables.huddleParticipants).get()
      if (active) throw new HttpError(409, 'Disconnect existing huddles before changing the RealtimeKit account or app')
      await db.delete(tables.huddles).run()
    }
    for (const key of ['realtimeToken', 'openrouterKey'] as const) if (input[key] !== undefined) await setSetting(env, key, input[key] ? await encrypt(input[key], env.APP_SECRET) : '')
    for (const key of ['realtimeAccountId', 'realtimeAppId', 'realtimePreset', 'realtimeListenerPreset', 'aiModel'] as const) await setSetting(env, key, input[key])
    return json(await integrationStatus(env))
  }
  if (endpoint?.name === 'integrationsAiTest') {
    if (user.role !== 'owner') throw new HttpError(403, 'Only the installation owner can test credentials')
    await testAI(env)
    return json({ ok: true })
  }
  if (endpoint?.name === 'integrationsTest') {
    if (user.role !== 'owner') throw new HttpError(403, 'Only the installation owner can test credentials')
    const presets = z.array(z.object({ name: z.string() }).passthrough()).parse(await realtimeRequest(env, '/presets'))
    const expected = await getSetting(env, 'realtimePreset')
    if (!presets.some((preset) => preset.name === expected)) throw new HttpError(400, 'Credentials work, but the configured participant preset was not found')
    return json({ ok: true, presets: presets.map((preset) => preset.name) })
  }
  if (endpoint?.name === 'database') {
    if (user.role !== 'owner') throw new HttpError(403, 'Only the installation owner can view database details')
    const history = await env.DB.prepare('SELECT name, applied_at AS appliedAt FROM app_migrations ORDER BY name').all()
    const counts = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM channels) AS channels, (SELECT COUNT(*) FROM users WHERE role NOT IN (\'bot\', \'legacy\')) AS users').first()
    return json({ migrations: history.results, counts, storage: 'D1-compatible SQLite', driver: 'Drizzle ORM' })
  }
  throw new HttpError(404, 'Not found')
}

// Both D1-compatible runtimes share behavior; platform bindings stay in this adapter.
export function createD1Handler(engine: 'celld' | 'cloudflare') {
return {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (await maintenanceActive(env)) return
    if (event.cron !== '* * * * *') ctx.waitUntil(cleanupAttachments(env))
    ctx.waitUntil(flushTelegramNotifications(env))
    ctx.waitUntil(flushAppEvents(env))
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get('Origin')
    const remote = origin && origin !== new URL(request.url).origin
    const cors: Record<string, string> = {}
    if (remote) {
      try { const parsed = new URL(origin); if (parsed.origin !== origin || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) return json({ message: 'Invalid remote origin' }, 403) } catch { return json({ message: 'Invalid origin' }, 403) }
      Object.assign(cors, { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' })
    }
    if (request.method === 'OPTIONS' && new URL(request.url).pathname.startsWith('/api/')) return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key', 'Access-Control-Max-Age': '600' } })
    try {
      const response = await route(request, env, engine, ctx)
      if (response.status === 101) return response
      const headers = new Headers(response.headers)
      for (const [key, value] of Object.entries(cors)) headers.set(key, value)
      // Remote sessions travel explicitly in Authorization; never set cross-origin cookies.
      if (remote) headers.delete('Set-Cookie')
      // The signed token is returned only by explicit connectionLogin, never by cookie routes.
      headers.delete('set-auth-token')
      headers.delete('Access-Control-Expose-Headers')
      headers.set('X-Content-Type-Options', 'nosniff')
      headers.set('Referrer-Policy', 'same-origin')
      headers.set('X-Frame-Options', 'DENY')
      if (headers.get('Content-Type')?.includes('text/html')) {
        headers.delete('X-Frame-Options')
        const policy = (headers.get('Content-Security-Policy') || '').replace(/(?:^|;)\s*frame-ancestors[^;]*/gi, '')
        headers.set('Content-Security-Policy', `${policy}${policy ? '; ' : ''}frame-ancestors 'self' https://web.telegram.org`)
      }
      if (new URL(request.url).pathname.startsWith('/api/')) headers.set('Cache-Control', 'no-store')
      return new Response(response.body, { status: response.status, headers })
    } catch (error) {
      if (error instanceof Error && error.message.includes('Anycord maintenance: writes are paused')) return json({ message: 'Installation maintenance is in progress. Your draft is kept.' }, 503, cors)
      if (error instanceof ZodError) return json({ message: error.issues[0]?.message || 'Invalid input' }, 400, cors)
      if (error instanceof URIError) return json({ message: 'Invalid path encoding' }, 400, cors)
      if (error instanceof HttpError) return json({ message: error.message }, error.status, { ...cors, ...(error.status === 429 ? { 'Retry-After': '60' } : {}) })
      console.error(JSON.stringify({ event: 'request_failed', kind: error instanceof Error ? error.name : 'Unknown' }))
      return json({ message: 'Something went wrong. Try again.' }, 500, cors)
    }
  },
} satisfies ExportedHandler<Env>

}

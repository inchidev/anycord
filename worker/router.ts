import { z, ZodError } from 'zod'
import { inviteTokenSchema, inviteInputSchema, recoveryResetSchema, passwordProofSchema } from '../shared/contracts'
import { generateRecoveryKeys, resetWithRecoveryKey, randomToken, requireServerOwner, previewInvite, acceptInvite } from './access'
import { and, eq, sql, desc } from 'drizzle-orm'
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

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
const hub = (env: Env, workspaceId: string) => env.HUBS.getByName(workspaceId)
async function publish(env: Env, workspaceId: string, event: LiveEvent) {
  // D1 is the source of truth. A failed notification never rolls back an acknowledged write.
  try { await hub(env, workspaceId).emit(event) } catch { console.warn(JSON.stringify({ event: 'broadcast_failed', workspaceId })) }
}
async function route(request: Request, env: Env, engine: 'celld' | 'cloudflare'): Promise<Response> {
  const url = new URL(request.url), path = url.pathname, method = request.method
  if (!path.startsWith('/api/')) {
    const response = await env.ASSETS.fetch(request)
    // celld's asset server can redirect generated page directories to a trailing
    // slash and then return 404. Serve the SPA shell for extensionless routes.
    if (engine === 'celld' && response.status === 404 && !path.split('/').filter(Boolean).at(-1)?.includes('.')) return env.ASSETS.fetch(new Request(new URL('/', request.url), request))
    return response
  }
  const endpoint = matchEndpoint(method, path)
  if (endpoint?.name === 'runtime') return json({ apiVersion: API_VERSION, engine, auth: 'better-auth', realtime: 'websocket', build: buildInfo })
  if (path === '/api/_runtime') return json({ ok: true })
  if (path === '/api/_migrate' && method === 'POST') {
    if (!env.MIGRATION_TOKEN || !await equalSecret(request.headers.get('X-Migration-Token') || '', env.MIGRATION_TOKEN)) throw new HttpError(403, 'Migration access denied')
    const input = z.object({ target: z.string().optional(), legacy: z.array(z.object({ id: z.string(), name: z.string(), text: z.string(), sentAt: z.number() })).max(100).optional() }).parse(await readBody(request, 1_000_000))
    const result = await applyMigrations(env.DB, input.target)
    await seedDatabase(env.DB, input.legacy)
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
  const explicitLogin = endpoint?.name === 'connectionLogin' || endpoint?.name === 'authStatus'
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
      if (migration.migrated) return Response.json({ initialized, user: migration.user }, { headers: response.headers })
    }
    return json({ initialized, setupRequired: !initialized && !!env.SETUP_TOKEN, user: await currentUser(request, env) })
  }
  if (endpoint?.name === 'authRegister' || endpoint?.name === 'authLogin' || endpoint?.name === 'connectionLogin') {
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
      const input = z.object({ username: z.string().min(2).max(32), password: z.string().max(128) }).passthrough().parse(await readBody(request))
      if (!await hub(env, '_auth').consumeRate(`auth:${input.username.toLowerCase()}`, 15)) throw new HttpError(429, 'Too many attempts. Try again in a minute.')
      return createAuth(env).handler(new Request(request.url, { method, headers: request.headers, body: JSON.stringify(input) }))
    }
    return createAuth(env).handler(request)
  }
  const user = await requireUser(request, env)
  if (!['GET', 'HEAD'].includes(method) && !await hub(env, '_auth').consumeRate(`writes:${user.id}`, 90)) throw new HttpError(429, 'You are sending too quickly. Try again in a minute.')
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
    await requireServerOwner(env, user.id, workspaceId)
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
    if (endpoint.name === 'bans') return json(await db.select({ id: tables.users.id, name: tables.users.name, createdAt: tables.workspaceBans.createdAt }).from(tables.workspaceBans).innerJoin(tables.users, eq(tables.workspaceBans.userId, tables.users.id)).where(eq(tables.workspaceBans.workspaceId, workspaceId)).all())
    if (endpoint.name === 'memberUnban') {
      await db.delete(tables.workspaceBans).where(and(eq(tables.workspaceBans.workspaceId, workspaceId), eq(tables.workspaceBans.userId, endpoint.params.userId!))).run()
      return json({ ok: true })
    }
    const removed = await hub(env, workspaceId).removeMember(workspaceId, user.id, endpoint.params.userId!, endpoint.name === 'memberBan')
    if (!removed.ok) throw new HttpError(removed.status, removed.message)
    await publish(env, workspaceId, { type: 'refresh' })
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
  if (endpoint?.name === 'bootstrap') {
    const spaces = await db.select({ id: tables.workspaces.id, name: tables.workspaces.name, initials: tables.workspaces.initials, role: tables.memberships.role })
      .from(tables.workspaces).innerJoin(tables.memberships, and(eq(tables.memberships.workspaceId, tables.workspaces.id), eq(tables.memberships.userId, user.id))).all()
    const workspaceId = url.searchParams.get('workspace') || spaces[0]?.id || 'main'
    await requireMembership(env, user.id, workspaceId)
    const channels = await db.select().from(tables.channels).where(eq(tables.channels.workspaceId, workspaceId)).orderBy(tables.channels.position).all()
    const members = await db.select({ id: tables.users.id, name: tables.users.name, color: tables.users.color, role: tables.users.role, workspaceRole: tables.memberships.role }).from(tables.users)
      .innerJoin(tables.memberships, and(eq(tables.memberships.userId, tables.users.id), eq(tables.memberships.workspaceId, workspaceId))).all()
    return json({ user, workspaces: spaces, channels, members })
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
    return json({ id }, 201)
  }
  if (endpoint?.name === 'workspaceUpdate') {
    const workspaceId = endpoint.params.workspaceId!
    const membership = await requireMembership(env, user.id, workspaceId)
    if (membership.role !== 'owner') throw new HttpError(403, 'Only the server owner can change server settings')
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
    const membership = await requireMembership(env, user.id, workspaceId)
    if (membership.role !== 'owner') throw new HttpError(403, 'Only the server owner can create channels')
    const input = channelSchema.parse(await readBody(request)), id = crypto.randomUUID()
    await db.insert(tables.channels).values({ id, workspaceId, ...input, position: Date.now() }).run()
    await publish(env, workspaceId, { type: 'refresh' })
    return json({ id }, 201)
  }
  if (endpoint?.name === 'search') {
    const workspaceId = url.searchParams.get('workspace') || 'main'
    await requireMembership(env, user.id, workspaceId)
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100)
    if (!q) return json([])
    const rows = await db.select({ id: tables.messages.id, text: tables.messages.text, channelId: tables.channels.id, channel: tables.channels.name, authorId: tables.users.id, author: tables.users.name, createdAt: tables.messages.createdAt, threadId: tables.messages.threadId })
      .from(tables.messages).innerJoin(tables.channels, eq(tables.channels.id, tables.messages.channelId)).innerJoin(tables.users, eq(tables.users.id, tables.messages.authorId))
      .where(and(eq(tables.channels.workspaceId, workspaceId), sql`instr(lower(${tables.messages.text}), lower(${q})) > 0`))
      .orderBy(desc(tables.messages.createdAt)).limit(40).all()
    return json(rows.map(({ authorId, ...row }) => ({ ...row, author: authorId === 'system' ? 'Anycord' : row.author })))
  }
  if (endpoint?.params.channelId) {
    const channelId = endpoint.params.channelId, item = endpoint.params.messageId || endpoint.params.participantId
    const channel = await requireChannel(env, user, channelId)
    if (endpoint.name === 'attachmentCreate') return json(await createAttachment(env, user, channelId, request), 201)
    if (endpoint.name === 'channelUpdate') {
      const membership = await requireMembership(env, user.id, channel.workspaceId)
      if (membership.role !== 'owner') throw new HttpError(403, 'Only the server owner can change channels')
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
      if (inserted) await publish(env, channel.workspaceId, { type: 'message', message })
      return json(message, inserted ? 201 : 200)
    }
    if (item && ['messageEdit', 'messageDelete', 'reactionToggle'].includes(endpoint.name)) {
      const message = await db.select().from(tables.messages).where(and(eq(tables.messages.id, item), eq(tables.messages.channelId, channelId))).get()
      if (!message) throw new HttpError(404, 'Message not found')
      if (method === 'PATCH') {
        if (message.authorId !== user.id) throw new HttpError(403, 'You can only edit your own messages')
        const input = editMessageSchema.parse(await readBody(request))
        await db.update(tables.messages).set({ text: input.text, editedAt: Date.now() }).where(eq(tables.messages.id, item)).run()
      } else if (method === 'DELETE') {
        const membership = await requireMembership(env, user.id, channel.workspaceId)
        if (message.authorId !== user.id && membership.role !== 'owner') throw new HttpError(403, 'You cannot delete this message')
        await db.delete(tables.messages).where(eq(tables.messages.id, item)).run()
      } else if (method === 'POST') {
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
    for (const key of ['realtimeAccountId', 'realtimeAppId', 'realtimePreset', 'aiModel'] as const) await setSetting(env, key, input[key])
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
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(cleanupAttachments(env)) },
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin')
    const remote = origin && origin !== new URL(request.url).origin
    const cors: Record<string, string> = {}
    if (remote) {
      try { const parsed = new URL(origin); if (parsed.origin !== origin || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) return json({ message: 'Invalid remote origin' }, 403) } catch { return json({ message: 'Invalid origin' }, 403) }
      Object.assign(cors, { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' })
    }
    if (request.method === 'OPTIONS' && new URL(request.url).pathname.startsWith('/api/')) return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' } })
    try {
      const response = await route(request, env, engine)
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
      if (new URL(request.url).pathname.startsWith('/api/')) headers.set('Cache-Control', 'no-store')
      return new Response(response.body, { status: response.status, headers })
    } catch (error) {
      if (error instanceof ZodError) return json({ message: error.issues[0]?.message || 'Invalid input' }, 400, cors)
      if (error instanceof URIError) return json({ message: 'Invalid path encoding' }, 400, cors)
      if (error instanceof HttpError) return json({ message: error.message }, error.status, cors)
      console.error(JSON.stringify({ event: 'request_failed', kind: error instanceof Error ? error.name : 'Unknown' }))
      return json({ message: 'Something went wrong. Try again.' }, 500, cors)
    }
  },
} satisfies ExportedHandler<Env>

}

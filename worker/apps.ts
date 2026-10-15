import { and, eq, desc, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { slackWebhookInputSchema, slackMessageSchema, appConfigSchema, appPolicySchema, appUrlSchema, commandInvokeSchema, pingCommand, validateCommandArguments, webhookMessageSchema, type AppConfig } from '../shared/apps'
import type { User } from '../shared/contracts'
import { serverApps, appAudit, appInvocations, appOutbox, users, appSlackWebhooks } from '../db/schema'
import { database, getMessages, getSetting, requireChannel, requireMembership } from './store'
import { requireServerOwner, randomToken } from './access'
import { decrypt, digest, encrypt, equalSecret, HttpError, readBody } from './security'
import type { EndpointName } from '../shared/api'

type AppRow = typeof serverApps.$inferSelect
type Grant = { app: AppRow; policy: string }
const json = (data: unknown, status = 200) => Response.json(data, { status })
export async function appPolicy(env: Env) {
  return appPolicySchema.parse(JSON.parse(await getSetting(env, 'appsPolicy') || '{"enabled":false,"allowedOrigins":[]}'))
}
function permitted(app: AppRow, policy: z.infer<typeof appPolicySchema>) {
  return policy.enabled && (!app.endpointUrl || policy.allowedOrigins.includes(new URL(app.endpointUrl).origin))
}
function config(app: AppRow): AppConfig {
  return appConfigSchema.parse({ ...app, enabled: !!app.enabled, channelIds: JSON.parse(app.channelIds), events: JSON.parse(app.events), commands: JSON.parse(app.commands) })
}
function presentation(app: AppRow, policy: z.infer<typeof appPolicySchema>) {
  return { ...config(app), id: app.id, workspaceId: app.workspaceId, createdAt: app.createdAt,
    status: !permitted(app, policy) ? 'policy-blocked' as const : app.enabled ? 'active' as const : 'disabled' as const,
    permissions: ['Post messages in authorized channels', ...(app.kind === 'ping' || JSON.parse(app.commands).length ? ['Receive explicit command arguments and invoking member ID'] : []), ...(JSON.parse(app.events).length ? ['Receive new human messages in authorized channels'] : [])] }
}
function audit(env: Env, workspaceId: string, appId: string | null, actorId: string, action: string) {
  return database(env).insert(appAudit).values({ id: crypto.randomUUID(), workspaceId, appId, actorId, action, createdAt: Date.now() })
}
async function findApp(env: Env, id: string, workspaceId?: string) {
  const app = await database(env).select().from(serverApps).where(and(eq(serverApps.id, id), isNull(serverApps.uninstalledAt), workspaceId ? eq(serverApps.workspaceId, workspaceId) : undefined)).get()
  if (!app) throw new HttpError(404, 'App not found')
  return app
}
async function grant(env: Env, app: AppRow, channelId: string): Promise<Grant> {
  const policy = await getSetting(env, 'appsPolicy')
  if (!app.enabled || !permitted(app, await appPolicy(env))) throw new HttpError(403, 'This app is disabled by its owner or installation policy')
  const channel = await database(env).query.channels.findFirst({ where: (c, { eq }) => eq(c.id, channelId) })
  if (!channel || channel.workspaceId !== app.workspaceId || channel.kind !== 'text' || !JSON.parse(app.channelIds).includes(channelId)) throw new HttpError(403, 'Channel is not authorized for this app')
  return { app, policy }
}
// Recheck the live credential, grant and policy in the write itself. A preflight
// check alone would allow a concurrent uninstall/rotation to race an awaited call.
const guard = `EXISTS (SELECT 1 FROM server_apps a JOIN channels c ON c.workspace_id = a.workspace_id
  WHERE a.id = ? AND a.token_hash = ? AND a.enabled = 1 AND a.uninstalled_at IS NULL AND c.id = ? AND c.kind = 'text'
  AND EXISTS (SELECT 1 FROM json_each(a.channel_ids) WHERE value = c.id)
  AND a.commands = ? AND a.endpoint_url = ? AND a.events = ? AND (SELECT value FROM settings WHERE key = 'appsPolicy') = ?)`
function guardArgs(g: Grant, channelId: string) { return [g.app.id, g.app.tokenHash, channelId, g.app.commands, g.app.endpointUrl, g.app.events, g.policy] }
function cancelPending(env: Env, appId: string) {
  return [env.DB.prepare("UPDATE app_outbox SET status = 'cancelled', lease = NULL WHERE app_id = ? AND status IN ('pending', 'sending')").bind(appId),
    env.DB.prepare("UPDATE app_invocations SET status = 'cancelled', error = 'App access changed. Run the command again.' WHERE app_id = ? AND status = 'pending'").bind(appId)]
}
async function checkConfig(env: Env, workspaceId: string, input: AppConfig) {
  const policy = await appPolicy(env)
  if (!policy.enabled || (input.endpointUrl && !policy.allowedOrigins.includes(new URL(input.endpointUrl).origin))) throw new HttpError(403, 'The installation owner must enable apps and approve this endpoint origin')
  const rows = await database(env).query.channels.findMany({ where: (c, { eq }) => eq(c.workspaceId, workspaceId) })
  if (input.channelIds.some(id => !rows.some(c => c.id === id && c.kind === 'text'))) throw new HttpError(403, 'Authorize text channels belonging to this server')
}
function values(input: AppConfig) { return { ...input, endpointUrl: input.endpointUrl ? new URL(input.endpointUrl).href : '', channelIds: JSON.stringify(input.channelIds), events: JSON.stringify(input.events), commands: JSON.stringify(input.commands), enabled: Number(input.enabled) } }

export async function handleAppManagement(env: Env, user: User, name: EndpointName, params: Record<string, string>, request: Request): Promise<Response | undefined> {
  if (name === 'appPolicy' || name === 'appPolicyUpdate') {
    if (user.role !== 'owner') throw new HttpError(403, 'Only the installation owner can set app policy')
    if (name === 'appPolicyUpdate') {
      const input = appPolicySchema.parse(await readBody(request))
      await env.DB.batch([
        env.DB.prepare("INSERT INTO settings (key, value) VALUES ('appsPolicy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(input)),
        env.DB.prepare("UPDATE app_outbox SET status = 'cancelled', lease = NULL WHERE status IN ('pending', 'sending')"),
        env.DB.prepare("UPDATE app_invocations SET status = 'cancelled', error = 'Installation app policy changed' WHERE status = 'pending'"),
      ])
      // Installation-wide changes are recorded in each affected server, plus main.
      const spaces = await env.DB.prepare("SELECT id FROM workspaces WHERE id = 'main' OR id IN (SELECT workspace_id FROM server_apps)").all<{ id: string }>()
      for (const space of spaces.results) await audit(env, space.id, null, user.id, 'policy.updated').run()
    }
    return json(await appPolicy(env))
  }
  if (!['serverApps', 'appInstall', 'appUpdate', 'appRotate', 'appUninstall', 'appAudit', 'appDeliveries', 'slackWebhooks', 'slackWebhookCreate', 'slackWebhookRotate', 'slackWebhookRevoke'].includes(name)) return
  const workspaceId = params.workspaceId!, db = database(env)
  await requireServerOwner(env, user.id, workspaceId)
  if (name === 'serverApps') {
    const policy = await appPolicy(env)
    const apps = await db.select().from(serverApps).where(and(eq(serverApps.workspaceId, workspaceId), isNull(serverApps.uninstalledAt))).all()
    return json({ apps: apps.map(app => presentation(app, policy)), policy })
  }
  if (name === 'appAudit') return json(await db.select({ id: appAudit.id, appId: appAudit.appId, actorId: appAudit.actorId, action: appAudit.action, createdAt: appAudit.createdAt }).from(appAudit).where(eq(appAudit.workspaceId, workspaceId)).orderBy(desc(appAudit.createdAt), desc(appAudit.id)).limit(100).all())
  if (name === 'appDeliveries') return json(await db.select({ id: appOutbox.id, appId: appOutbox.appId, type: appOutbox.type, status: appOutbox.status, attempts: appOutbox.attempts, createdAt: appOutbox.createdAt, lastError: appOutbox.lastError }).from(appOutbox).innerJoin(serverApps, eq(serverApps.id, appOutbox.appId)).where(eq(serverApps.workspaceId, workspaceId)).orderBy(desc(appOutbox.createdAt)).limit(100).all())
  if (name === 'appInstall') {
    const input = appConfigSchema.parse(await readBody(request)); await checkConfig(env, workspaceId, input)
    // The database trigger also enforces this limit across concurrent installs.
    const count = await db.select({ id: serverApps.id }).from(serverApps).where(and(eq(serverApps.workspaceId, workspaceId), isNull(serverApps.uninstalledAt))).all()
    if (count.length >= 20) throw new HttpError(409, 'This server has reached its limit of 20 apps')
    const id = crypto.randomUUID(), botUserId = `app:${id}`, token = `ac_app_${randomToken(32)}`, signingSecret = randomToken(32)
    await db.batch([
      db.insert(users).values({ id: botUserId, name: botUserId, passwordHash: '!', color: '#8b5cf6', role: 'bot', createdAt: Date.now() }),
      db.insert(serverApps).values({ ...values(input), id, workspaceId, botUserId, tokenHash: await digest(token), signingSecret: await encrypt(signingSecret, env.APP_SECRET), createdAt: Date.now() }),
      audit(env, workspaceId, id, user.id, 'app.installed'),
    ])
    return json({ app: presentation(await findApp(env, id), await appPolicy(env)), token, signingSecret }, 201)
  }
  const app = await findApp(env, params.appId!, workspaceId)
  if (['slackWebhooks', 'slackWebhookCreate', 'slackWebhookRotate', 'slackWebhookRevoke'].includes(name)) return manageSlackWebhook(env, user, app, name, params, request)
  if (name === 'appUninstall') {
    await env.DB.batch([env.DB.prepare("UPDATE server_apps SET enabled = 0, token_hash = '', signing_secret = '', endpoint_url = '', commands = '[]', events = '[]', channel_ids = '[]', uninstalled_at = ? WHERE id = ?").bind(Date.now(), app.id), env.DB.prepare('DELETE FROM app_slack_webhooks WHERE app_id = ?').bind(app.id), ...cancelPending(env, app.id)])
    await audit(env, workspaceId, app.id, user.id, 'app.uninstalled').run()
    return json({ ok: true })
  }
  if (name === 'appRotate') {
    const token = `ac_app_${randomToken(32)}`, signingSecret = randomToken(32)
    await env.DB.batch([env.DB.prepare('UPDATE server_apps SET token_hash = ?, signing_secret = ? WHERE id = ? AND uninstalled_at IS NULL').bind(await digest(token), await encrypt(signingSecret, env.APP_SECRET), app.id), env.DB.prepare('DELETE FROM app_slack_webhooks WHERE app_id = ?').bind(app.id), ...cancelPending(env, app.id)])
    await audit(env, workspaceId, app.id, user.id, 'credentials.rotated').run()
    return json({ app: presentation(await findApp(env, app.id), await appPolicy(env)), token, signingSecret })
  }
  const input = appConfigSchema.parse(await readBody(request))
  if (input.kind !== app.kind) throw new HttpError(400, 'Uninstall and install a new app to change its type')
  // Disabling must always be possible, including after installation policy changes.
  if (input.enabled) await checkConfig(env, workspaceId, input)
  await env.DB.batch([
    env.DB.prepare('UPDATE server_apps SET name = ?, avatar_url = ?, channel_ids = ?, enabled = ?, endpoint_url = ?, events = ?, commands = ? WHERE id = ? AND uninstalled_at IS NULL')
      .bind(input.name, input.avatarUrl, JSON.stringify(input.channelIds), Number(input.enabled), input.endpointUrl ? new URL(input.endpointUrl).href : '', JSON.stringify(input.events), JSON.stringify(input.commands), app.id),
    env.DB.prepare('DELETE FROM app_slack_webhooks WHERE app_id = ? AND channel_id NOT IN (SELECT value FROM json_each(?))').bind(app.id, JSON.stringify(input.channelIds)), ...cancelPending(env, app.id),
  ])
  await audit(env, workspaceId, app.id, user.id, input.enabled ? 'app.configured' : 'app.disabled').run()
  return json(presentation(await findApp(env, app.id), await appPolicy(env)))
}
async function post(env: Env, g: Grant, requestId: string, channelId: string, text: string, command?: { id: string; userId: string; lease?: string }, webhook?: { id: string; tokenHash: string }) {
  const requestHash = await digest(JSON.stringify([channelId, text])), messageId = crypto.randomUUID()
  const commandGuard = command ? ` AND EXISTS (SELECT 1 FROM app_invocations i JOIN memberships m ON m.user_id = i.user_id
    WHERE i.id = ? AND i.status = 'pending' AND m.workspace_id = ? AND i.user_id = ?)${command.lease ? " AND EXISTS (SELECT 1 FROM app_outbox WHERE id = ? AND lease = ? AND status = 'sending')" : ''}` : ''
  const webhookGuard = webhook ? ' AND EXISTS (SELECT 1 FROM app_slack_webhooks WHERE id = ? AND token_hash = ? AND app_id = ? AND channel_id = ?)' : ''
  const webhookArgs = webhook ? [webhook.id, webhook.tokenHash, g.app.id, channelId] : []
  const args = [...guardArgs(g, channelId), ...webhookArgs, ...(command ? [command.id, g.app.workspaceId, command.userId, ...(command.lease ? [command.id, command.lease] : [])] : [])]
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO app_message_requests (app_id, request_id, request_hash, message_id)
      SELECT ?, ?, ?, ? WHERE ${guard}${webhookGuard}${commandGuard} ON CONFLICT(app_id, request_id) DO NOTHING`)
      .bind(g.app.id, requestId, requestHash, messageId, ...args),
    env.DB.prepare(`INSERT INTO messages (id, channel_id, author_id, text, created_at, app_id, app_request_id, app_request_hash)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM app_message_requests WHERE app_id = ? AND request_id = ? AND message_id = ?)`)
      .bind(messageId, channelId, g.app.botUserId, text, Date.now(), g.app.id, requestId, requestHash, g.app.id, requestId, messageId),
  ])
  // Even a duplicate receipt cannot serve data after its grant/credential changed.
  if (!await env.DB.prepare(`SELECT 1 AS ok WHERE ${guard}${webhookGuard}`).bind(...guardArgs(g, channelId), ...webhookArgs).first()) throw new HttpError(403, 'App access changed. Refresh its credentials and channel grants.')
  const saved = await env.DB.prepare('SELECT message_id AS id, request_hash AS hash FROM app_message_requests WHERE app_id = ? AND request_id = ?').bind(g.app.id, requestId).first<{ id: string; hash: string }>()
  if (!saved) throw new HttpError(403, 'App or command access changed')
  if (saved.hash !== requestHash) throw new HttpError(409, 'This request ID was already used with different content')
  const message = (await getMessages(env, channelId, g.app.botUserId, saved.id))[0]
  if (!message) throw new HttpError(409, 'The saved message was removed; this request ID cannot be reused')
  if (result[1]!.meta.changes) {
    await audit(env, g.app.workspaceId, g.app.id, g.app.id, 'message.posted').run()
    try { await env.HUBS.getByName(g.app.workspaceId).emit({ type: 'message', message }) } catch { console.warn(JSON.stringify({ event: 'app_broadcast_failed', appId: g.app.id })) }
  }
  return { message, inserted: !!result[1]!.meta.changes }
}
export async function incomingAppMessage(env: Env, appId: string, request: Request) {
  const app = await findApp(env, appId)
  const token = request.headers.get('Authorization')?.match(/^Bearer (ac_app_[a-f0-9]{64})$/)?.[1]
  if (!token || !await equalSecret(await digest(token), app.tokenHash)) throw new HttpError(401, 'Invalid app credential')
  if (!await env.HUBS.getByName(app.workspaceId).consumeRate(`app:${app.id}`, 30)) throw new HttpError(429, 'App rate limit reached. Retry in a minute.')
  const input = webhookMessageSchema.parse(await readBody(request)), g = await grant(env, app, input.channelId)
  const result = await post(env, g, input.id, input.channelId, input.text)
  // A post-only credential must not learn human thread/reaction metadata on retries.
  return json({ ...result.message, reactions: [], thread: null }, result.inserted ? 201 : 200)
}
export async function commandRegistry(env: Env, user: User, channelId: string) {
  const channel = await requireChannel(env, user, channelId), policy = await appPolicy(env)
  const apps = await database(env).select().from(serverApps).where(and(eq(serverApps.workspaceId, channel.workspaceId), eq(serverApps.enabled, 1), isNull(serverApps.uninstalledAt))).all()
  return apps.filter(app => channel.kind === 'text' && permitted(app, policy) && JSON.parse(app.channelIds).includes(channelId))
    .flatMap(app => (app.kind === 'ping' ? [pingCommand] : config(app).commands).map(command => ({ ...command, appId: app.id, appName: app.name })))
}
export async function invocationResult(env: Env, user: User, channelId: string, id: string) {
  await requireChannel(env, user, channelId)
  const invocation = await database(env).select().from(appInvocations).where(and(eq(appInvocations.id, id), eq(appInvocations.channelId, channelId), eq(appInvocations.userId, user.id))).get()
  if (!invocation) throw new HttpError(404, 'Command invocation not found')
  return { id, status: invocation.status, error: invocation.error, message: invocation.messageId ? (await getMessages(env, channelId, user.id, invocation.messageId))[0] || null : null }
}
export async function invokeCommand(env: Env, user: User, channelId: string, request: Request) {
  const input = commandInvokeSchema.parse(await readBody(request))
  await requireChannel(env, user, channelId)
  const app = await findApp(env, input.appId), g = await grant(env, app, channelId)
  // Validate against the same configuration snapshot guarded by the write.
  const command = (app.kind === 'ping' ? [pingCommand] : config(app).commands).find(c => c.name === input.name)
  if (!command) throw new HttpError(404, 'Command is unavailable in this channel')
  const args = validateCommandArguments(command, input.arguments)
  if (!await env.HUBS.getByName(app.workspaceId).consumeRate(`command:${user.id}`, 15)) throw new HttpError(429, 'Command rate limit reached. Retry in a minute.')
  const hash = await digest(JSON.stringify([app.id, channelId, user.id, input.name, Object.entries(args).sort(([a], [b]) => a.localeCompare(b))]))
  const now = Date.now(), event = { id: input.id, type: 'command.invoked', createdAt: now, data: { workspaceId: app.workspaceId, channelId, userId: user.id, name: input.name, arguments: args } }
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO app_invocations (id, app_id, channel_id, user_id, request_hash, status, created_at) SELECT ?, ?, ?, ?, ?, 'pending', ? WHERE ${guard}
      AND EXISTS (SELECT 1 FROM memberships WHERE user_id = ? AND workspace_id = ?) ON CONFLICT(id) DO NOTHING`)
      .bind(input.id, app.id, channelId, user.id, hash, now, ...guardArgs(g, channelId), user.id, app.workspaceId),
    ...(app.kind === 'ping' ? [] : [env.DB.prepare("INSERT INTO app_outbox (id, app_id, channel_id, type, payload, due_at, created_at) SELECT ?, ?, ?, 'command.invoked', ?, ?, ? WHERE changes() = 1").bind(input.id, app.id, channelId, JSON.stringify(event), now, now)]),
  ])
  if (result[0]!.meta.changes) await audit(env, app.workspaceId, app.id, user.id, 'command.invoked').run()
  const invocation = await database(env).select().from(appInvocations).where(eq(appInvocations.id, input.id)).get()
  if (!invocation) throw new HttpError(403, 'Command access changed')
  if (invocation.requestHash !== hash) throw new HttpError(409, 'This invocation ID was already used with different arguments')
  if (app.kind === 'ping' && invocation.status === 'pending') {
    const { message } = await post(env, g, `command:${input.id}`, channelId, 'Pong!', { id: input.id, userId: user.id })
    await database(env).update(appInvocations).set({ status: 'completed', messageId: message.id }).where(and(eq(appInvocations.id, input.id), eq(appInvocations.status, 'pending'))).run()
  }
  return json(await invocationResult(env, user, channelId, input.id))
}
export async function signAppEvent(secret: string, timestamp: string, body: string) {
  const encoder = new TextEncoder(), key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`)))].map(v => v.toString(16).padStart(2, '0')).join('')
}
export async function flushAppEvents(env: Env) {
  const now = Date.now()
  // Expired leases are reclaimable. Receivers must deduplicate by stable event ID.
  const due = await env.DB.prepare("SELECT id FROM app_outbox WHERE status IN ('pending', 'sending') AND due_at <= ? ORDER BY due_at LIMIT 10").bind(now).all<{ id: string }>()
  await Promise.all(due.results.map(async ({ id }) => {
    const lease = crypto.randomUUID()
    const row = await env.DB.prepare("UPDATE app_outbox SET status = 'sending', lease = ?, attempts = attempts + 1, due_at = ? WHERE id = ? AND status IN ('pending', 'sending') AND due_at <= ? AND attempts < 5 RETURNING *")
      .bind(lease, now + 60_000, id, now).first<{ id: string; app_id: string; channel_id: string; type: string; payload: string; attempts: number }>()
    if (!row) {
      await env.DB.batch([env.DB.prepare("UPDATE app_outbox SET status = 'failed', last_error = 'Delivery retry limit reached' WHERE id = ? AND status IN ('pending', 'sending') AND attempts >= 5 AND due_at <= ?").bind(id, now),
        env.DB.prepare("UPDATE app_invocations SET status = 'failed', error = 'App delivery failed after five attempts' WHERE id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM app_outbox WHERE id = ? AND status = 'failed')").bind(id, id)])
      return
    }
    let status = 'sent', error: string | null = null
    try {
      const app = await findApp(env, row.app_id), g = await grant(env, app, row.channel_id)
      if (!app.endpointUrl || !appUrlSchema.safeParse(app.endpointUrl).success || (row.type === 'message.created' && !config(app).events.includes('message.created'))) throw new HttpError(403, 'Subscription was revoked')
      const event = JSON.parse(row.payload) as { data: { userId?: string } }
      if (row.type === 'command.invoked') await requireMembership(env, event.data.userId!, app.workspaceId)
      const owned = await env.DB.prepare("SELECT 1 AS ok FROM app_outbox WHERE id = ? AND lease = ? AND status = 'sending'").bind(id, lease).first()
      if (!owned) return
      const timestamp = String(Math.floor(Date.now() / 1000)), secret = await decrypt(app.signingSecret, env.APP_SECRET)
      const response = await fetch(app.endpointUrl, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: {
        'Content-Type': 'application/json', 'X-Anycord-Event-Id': id, 'X-Anycord-Timestamp': timestamp, 'X-Anycord-Signature': `v1=${await signAppEvent(secret, timestamp, row.payload)}`,
      }, body: row.payload })
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Endpoint returned HTTP ${response.status}`) }
      if (row.type === 'command.invoked') {
        const reply = z.object({ text: z.string().trim().min(1).max(4000) }).strict().parse(await readBody(response, 20_000))
        // Claim ownership still matters after network I/O; cancelled/reclaimed deliveries cannot respond.
        if (!await env.DB.prepare("SELECT 1 AS ok FROM app_outbox WHERE id = ? AND lease = ? AND status = 'sending'").bind(id, lease).first()) return
        await requireMembership(env, event.data.userId!, app.workspaceId)
        const { message } = await post(env, g, `command:${id}`, row.channel_id, reply.text, { id, userId: event.data.userId!, lease })
        await env.DB.prepare("UPDATE app_invocations SET status = 'completed', message_id = ? WHERE id = ? AND status = 'pending'").bind(message.id, id).run()
      } else await response.body?.cancel()
    } catch (cause) {
      if (cause instanceof HttpError && [403, 404].includes(cause.status)) { status = 'cancelled'; error = 'App or member access was revoked' }
      else { status = row.attempts >= 5 ? 'failed' : 'pending'; error = cause instanceof Error && /^Endpoint returned HTTP \d+$/.test(cause.message) ? cause.message : 'Endpoint timed out or returned an invalid response' }
    }
    const result = await env.DB.prepare("UPDATE app_outbox SET status = ?, last_error = ?, lease = NULL, due_at = ? WHERE id = ? AND lease = ? AND status = 'sending'")
      .bind(status, error, Date.now() + Math.min(900_000, 30_000 * 2 ** (row.attempts - 1)), id, lease).run()
    if (result.meta.changes && ['failed', 'cancelled'].includes(status)) {
      await env.DB.prepare("UPDATE app_invocations SET status = ?, error = ? WHERE id = ? AND status = 'pending'").bind(status, error, id).run()
      const app = await database(env).select().from(serverApps).where(eq(serverApps.id, row.app_id)).get()
      if (app) await audit(env, app.workspaceId, app.id, app.id, `delivery.${status}`).run()
    }
  }))
  // Retain a bounded diagnostic window without retaining message content indefinitely.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM app_outbox WHERE status NOT IN ('pending', 'sending') AND created_at < ?").bind(now - 7 * 86400_000),
    env.DB.prepare('DELETE FROM app_audit WHERE created_at < ?').bind(now - 30 * 86400_000),
  ])
}

async function manageSlackWebhook(env: Env, user: User, app: AppRow, name: EndpointName, params: Record<string, string>, request: Request) {
  const db = database(env)
  const metadata = { id: appSlackWebhooks.id, channelId: appSlackWebhooks.channelId, createdAt: appSlackWebhooks.createdAt }
  if (name === 'slackWebhooks') return json(await db.select(metadata).from(appSlackWebhooks).where(eq(appSlackWebhooks.appId, app.id)).orderBy(desc(appSlackWebhooks.createdAt)).all())
  if (name === 'slackWebhookRevoke') {
    const removed = await db.delete(appSlackWebhooks).where(and(eq(appSlackWebhooks.id, params.webhookId!), eq(appSlackWebhooks.appId, app.id))).returning({ id: appSlackWebhooks.id }).get()
    if (!removed) throw new HttpError(404, 'Webhook not found')
    await audit(env, app.workspaceId, app.id, user.id, 'slack_webhook.revoked').run()
    return json({ ok: true })
  }
  const token = randomToken(32), tokenHash = await digest(token), createdAt = Date.now()
  let id: string, channelId: string
  if (name === 'slackWebhookCreate') {
    const input = slackWebhookInputSchema.parse(await readBody(request)), g = await grant(env, app, input.channelId)
    id = crypto.randomUUID(); channelId = input.channelId
    const result = await env.DB.prepare(`INSERT INTO app_slack_webhooks (id, app_id, channel_id, token_hash, created_at)
      SELECT ?, ?, ?, ?, ? WHERE ${guard} ON CONFLICT(app_id, channel_id) DO NOTHING`).bind(id, app.id, channelId, tokenHash, createdAt, ...guardArgs(g, channelId)).run()
    if (!result.meta.changes) throw new HttpError(409, 'This channel already has a webhook or app access changed. Refresh, then rotate or revoke the existing URL.')
  } else {
    const existing = await db.select().from(appSlackWebhooks).where(and(eq(appSlackWebhooks.id, params.webhookId!), eq(appSlackWebhooks.appId, app.id))).get()
    if (!existing) throw new HttpError(404, 'Webhook not found')
    const g = await grant(env, app, existing.channelId)
    id = existing.id; channelId = existing.channelId
    const result = await env.DB.prepare(`UPDATE app_slack_webhooks SET token_hash = ?, created_at = ? WHERE id = ? AND app_id = ? AND ${guard}`)
      .bind(tokenHash, createdAt, id, app.id, ...guardArgs(g, channelId)).run()
    if (!result.meta.changes) throw new HttpError(409, 'Webhook access changed. Refresh its channel grants.')
  }
  await audit(env, app.workspaceId, app.id, user.id, name === 'slackWebhookCreate' ? 'slack_webhook.created' : 'slack_webhook.rotated').run()
  const path = `/api/compat/slack/services/${encodeURIComponent(app.workspaceId)}/${id}/${token}`
  return json({ id, channelId, createdAt, url: new URL(path, env.AUTH_BASE_URL).href }, name === 'slackWebhookCreate' ? 201 : 200)
}
const slackResponse = (text: string, status = 200) => new Response(text, { status, headers: {
  'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...(status === 405 ? { Allow: 'POST' } : {}), ...(status === 429 ? { 'Retry-After': '60' } : {}),
} })
export async function incomingSlackWebhook(env: Env, request: Request) {
  try {
    if (request.method !== 'POST') return slackResponse('method_not_allowed', 405)
    const match = /^\/api\/compat\/slack\/services\/([^/]+)\/([a-f0-9-]{36})\/([a-f0-9]{64})$/.exec(new URL(request.url).pathname)
    if (!match) return slackResponse('invalid_token', 404)
    const workspaceId = decodeURIComponent(match[1]!), id = match[2]!, token = match[3]!
    const hook = await database(env).select().from(appSlackWebhooks).where(eq(appSlackWebhooks.id, id)).get()
    if (!hook || !await equalSecret(await digest(token), hook.tokenHash)) return slackResponse('invalid_token', 404)
    const app = await findApp(env, hook.appId)
    if (app.workspaceId !== workspaceId) return slackResponse('invalid_token', 404)
    const g = await grant(env, app, hook.channelId)
    if (!await env.HUBS.getByName(app.workspaceId).consumeRate(`app:${app.id}`, 30)) return slackResponse('rate_limited', 429)
    const raw = await readBody(request)
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      if (['blocks', 'attachments', 'thread_ts', 'metadata'].some(key => key in raw)) return slackResponse('unsupported_payload', 400)
      if (!('text' in raw) || typeof raw.text === 'string' && !raw.text.trim()) return slackResponse('no_text', 400)
    }
    const input = slackMessageSchema.safeParse(raw)
    if (!input.success) return slackResponse('invalid_payload', 400)
    const key = request.headers.get('Idempotency-Key')
    if (key !== null && !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) return slackResponse('invalid_payload', 400)
    // No payload hashing for deduplication: two identical ordinary Slack posts
    // are two distinct notifications unless the sender supplies a stable key.
    await post(env, g, `slack:${hook.id}:${key ?? crypto.randomUUID()}`, hook.channelId, input.data.text, undefined, { id: hook.id, tokenHash: hook.tokenHash })
    return slackResponse('ok')
  } catch (error) {
    if (error instanceof URIError) return slackResponse('invalid_token', 404)
    if (error instanceof HttpError) {
      if (error.status === 403) return slackResponse('action_prohibited', 403)
      if (error.status === 404) return slackResponse('invalid_token', 404)
      if (error.status === 409) return slackResponse('idempotency_conflict', 409)
      return slackResponse('invalid_payload', error.status)
    }
    // Capability URLs and provider payloads never appear in logs or errors.
    console.error(JSON.stringify({ event: 'slack_webhook_failed', kind: error instanceof Error ? error.name : 'Unknown' }))
    return slackResponse('internal_error', 500)
  }
}

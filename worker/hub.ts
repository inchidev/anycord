import { initializeBackupStorage, beginNativeBackup, pumpNativeBackups } from './native-backups'
import { serverAccess, requirePermission, requireLowerMember, preparePermissionMutation, type PermissionMutation } from './permissions'
import { DurableObject } from 'cloudflare:workers'
import type { LiveEvent, User } from '../shared/contracts'
import { AUTH_SESSION_CLOSE_CODE, liveClientEventSchema } from '../shared/contracts'
import { database, requireMembership } from './store'
import { channels, threads } from '../db/schema'
import { and, eq } from 'drizzle-orm'
import { joinHuddle, leaveHuddle } from './services'
import { currentIdentity } from './auth'
import { HttpError } from './security'

type Attachment = { userId: string; name: string; workspaceId: string; sessionHash: string; expiresAt: number; lastTyping: number }
export class WorkspaceHub extends DurableObject<Env> {
  private huddleQueue: Promise<unknown> = Promise.resolve()
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    initializeBackupStorage(ctx.storage)
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)')
  }
  beginBackup(jobId: string, engine: 'cloudflare' | 'celld') {
    const result = this.huddleQueue.then(async () => {
      try { return await beginNativeBackup(this.env, this.ctx.storage, jobId, engine) }
      catch (error) { if (error instanceof HttpError) return { ok: false as const, status: error.status, message: error.message }; throw error }
    })
    this.huddleQueue = result.catch(() => undefined); return result
  }
  override alarm() {
    const result = this.huddleQueue.then(() => pumpNativeBackups(this.env, this.ctx.storage))
    this.huddleQueue = result.catch(() => undefined); return result
  }
  consumeRate(key: string, limit: number) {
    const bucket = Math.floor(Date.now() / 60_000)
    this.ctx.storage.sql.exec('DELETE FROM rate_limits WHERE expires < ?', Date.now())
    const row = this.ctx.storage.sql.exec<{ count: number }>('INSERT INTO rate_limits (key, count, expires) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count', `${key}:${bucket}`, Date.now() + 120_000).one()
    return row.count <= limit
  }
  override async fetch(request: Request) {
    const attachment = JSON.parse(request.headers.get('X-Cellcord-Identity')!) as Attachment
    const identity = await currentIdentity(request, this.env)
    if (!identity || identity.user.id !== attachment.userId) return new Response('Sign in again', { status: 401 })
    await requireMembership(this.env, attachment.userId, attachment.workspaceId)
    const pair = new WebSocketPair(), client = pair[0], server = pair[1]
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment(attachment)
    server.send(JSON.stringify({ type: 'ready' }))
    await this.presence()
    return new Response(null, { status: 101, webSocket: client })
  }
  emit(event: LiveEvent) {
    const result = this.huddleQueue.then(() => this.emitNow(event))
    this.huddleQueue = result.catch(() => undefined)
    return result
  }
  private async emitNow(event: LiveEvent) {
    const accessByUser = new Map<string, Awaited<ReturnType<typeof serverAccess>>>()
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment
      if (attachment.expiresAt < Date.now()) { ws.close(AUTH_SESSION_CLOSE_CODE, 'Session expired'); continue }
      let access = accessByUser.get(attachment.userId)
      if (!access) {
        try { access = await serverAccess(this.env, attachment.userId, attachment.workspaceId); accessByUser.set(attachment.userId, access) }
        catch (error) { if (error instanceof HttpError && error.status === 403) { ws.close(AUTH_SESSION_CLOSE_CODE, 'Access ended'); continue }; throw error }
      }
      const channelId = event.type === 'message' ? event.message.channelId : 'channelId' in event ? event.channelId : undefined
      if (channelId) {
        const permissions = access.channelPermissions(channelId)
        if (!permissions.includes('channels.view') || ((event.type === 'message' || event.type === 'typing') && !permissions.includes('messages.read'))) continue
      }
      try { ws.send(JSON.stringify(event)) } catch { /* Reconnect fetches current state. */ }
    }
  }
  async presence() {
    const users = new Set<string>()
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment
      if (ws.readyState === 1 && a.expiresAt > Date.now()) users.add(a.userId)
    }
    await this.emitNow({ type: 'presence', users: [...users] })
  }
  async revokeSession(hash: string) {
    for (const ws of this.ctx.getWebSockets()) if ((ws.deserializeAttachment() as Attachment).sessionHash === hash) ws.close(AUTH_SESSION_CLOSE_CODE, 'Signed out')
    await this.presence()
  }
  async revokeUser(userId: string) {
    for (const ws of this.ctx.getWebSockets()) if ((ws.deserializeAttachment() as Attachment).userId === userId) ws.close(AUTH_SESSION_CLOSE_CODE, 'Access ended')
    await this.presence()
  }
  removeMember(workspaceId: string, actorId: string, userId: string, ban: boolean) {
    const result = this.huddleQueue.then(async () => {
      try {
        await requireLowerMember(this.env, workspaceId, actorId, userId, ban ? 'members.ban' : 'members.remove')
        const target = await requireMembership(this.env, userId, workspaceId)
        if (target.role === 'owner') throw new HttpError(403, 'The server owner cannot be removed or banned')
        const calls = await this.env.DB.prepare('SELECT p.id, p.channel_id AS channelId FROM huddle_participants p JOIN channels c ON c.id = p.channel_id WHERE p.user_id = ? AND c.workspace_id = ?').bind(userId, workspaceId).all<{ id: string; channelId: string }>()
        // Stop provider access first; a failed provider removal leaves membership
        // intact and returns an actionable error instead of claiming a full ban.
        for (const call of calls.results) await leaveHuddle(this.env, call.channelId, call.id, userId)
        await this.env.DB.batch([
          this.env.DB.prepare("DELETE FROM channel_overrides WHERE subject_type = 'member' AND subject_id = ? AND channel_id IN (SELECT id FROM channels WHERE workspace_id = ?)").bind(userId, workspaceId),
          ...(ban ? [this.env.DB.prepare('INSERT INTO workspace_bans (workspace_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(workspaceId, userId, Date.now())] : []),
          this.env.DB.prepare('DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, userId),
        ])
        await this.revokeUser(userId)
        return { ok: true as const }
      } catch (error) {
        if (error instanceof HttpError) return { ok: false as const, status: error.status, message: error.message }
        throw error
      }
    })
    this.huddleQueue = result.catch(() => undefined)
    return result
  }
  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const a = ws.deserializeAttachment() as Attachment
    if (a.expiresAt < Date.now()) { ws.close(AUTH_SESSION_CLOSE_CODE, 'Session expired'); return }
    if (typeof raw !== 'string' || raw.length > 512) return
    let input: unknown
    try { input = JSON.parse(raw) } catch { return }
    const event = liveClientEventSchema.safeParse(input)
    if (!event.success || Date.now() - a.lastTyping < 1500) return
    try { await requireMembership(this.env, a.userId, a.workspaceId) } catch { ws.close(AUTH_SESSION_CLOSE_CODE, 'Access ended'); return }
    const channel = await database(this.env).select().from(channels).where(and(eq(channels.id, event.data.channelId), eq(channels.workspaceId, a.workspaceId))).get()
    if (!channel) return
    try { await requirePermission(this.env, a.userId, a.workspaceId, 'messages.send', channel.id) } catch (error) { if (error instanceof HttpError && error.status === 403) return; throw error }
    if (event.data.threadId && !await database(this.env).select({ id: threads.id }).from(threads).where(and(eq(threads.id, event.data.threadId), eq(threads.channelId, channel.id))).get()) return
    a.lastTyping = Date.now(); ws.serializeAttachment(a)
    await this.emit({ type: 'typing', userId: a.userId, name: a.name, channelId: channel.id, ...(event.data.threadId ? { threadId: event.data.threadId } : {}) })
  }
  override async webSocketClose(ws: WebSocket, code: number, reason: string) {
    ws.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, reason)
    await this.presence()
  }
  override async webSocketError(ws: WebSocket) { ws.close(4002, 'Connection error'); await this.presence() }
  mutatePermissions(workspaceId: string, actorId: string, action: PermissionMutation) {
    const result = this.huddleQueue.then(async () => {
      try {
        const change = await preparePermissionMutation(this.env, workspaceId, actorId, action)
        // End existing media grants before changing policy. A provider failure leaves
        // the policy unchanged and reports failure; joins share this queue.
        if (action.kind !== 'create') {
          const calls = await this.env.DB.prepare('SELECT p.id, p.user_id AS userId, p.channel_id AS channelId FROM huddle_participants p JOIN channels c ON c.id = p.channel_id WHERE c.workspace_id = ?').bind(workspaceId).all<{ id: string; userId: string; channelId: string }>()
          for (const call of calls.results) await leaveHuddle(this.env, call.channelId, call.id, call.userId)
        }
        // Permission revocation also fences replies already awaiting an app endpoint.
        // The command writer checks pending status in its atomic message insert.
        if (action.kind !== 'create') change.statements.push(
          this.env.DB.prepare("UPDATE app_outbox SET status='cancelled',lease=NULL WHERE type='command.invoked' AND status IN ('pending','sending') AND app_id IN (SELECT id FROM server_apps WHERE workspace_id=?)").bind(workspaceId),
          this.env.DB.prepare("UPDATE app_invocations SET status='cancelled',error='Channel permissions changed. Run the command again.' WHERE status='pending' AND app_id IN (SELECT id FROM server_apps WHERE workspace_id=?)").bind(workspaceId),
        )
        await this.env.DB.batch(change.statements)
        try { await this.emitNow({ type: 'permissions', endHuddles: action.kind !== 'create' }) } catch { console.warn(JSON.stringify({ event: 'permissions_broadcast_failed', workspaceId })) }
        return { ok: true as const, value: change.result }
      } catch (error) {
        if (error instanceof HttpError) return { ok: false as const, status: error.status, message: error.message }
        throw error
      }
    })
    this.huddleQueue = result.catch(() => undefined)
    return result
  }
  joinHuddle(channelId: string, title: string, user: User) {
    // Serializes creation across concurrent joins without blocking unrelated chat events.
    const result = this.huddleQueue.then(async () => {
      try {
        const channel = await database(this.env).select().from(channels).where(eq(channels.id, channelId)).get()
        if (!channel) throw new HttpError(404, 'Channel not found')
        const access = await requirePermission(this.env, user.id, channel.workspaceId, 'voice.connect', channel.id)
        return { ok: true as const, ...await joinHuddle(this.env, channelId, title, user, access.channelPermissions(channel.id).includes('voice.speak')) }
      }
      catch (error) {
        // RPC errors do not retain a custom Error subclass across isolates.
        if (error instanceof HttpError) return { ok: false as const, status: error.status, message: error.message }
        throw error
      }
    })
    this.huddleQueue = result.catch(() => undefined)
    return result
  }
}

import { DurableObject } from 'cloudflare:workers'
import type { LiveEvent, User } from '../shared/contracts'
import { AUTH_SESSION_CLOSE_CODE, liveClientEventSchema } from '../shared/contracts'
import { database, requireMembership } from './store'
import { channels, threads, memberships, workspaceBans } from '../db/schema'
import { and, eq } from 'drizzle-orm'
import { joinHuddle, leaveHuddle } from './services'
import { requireServerOwner } from './access'
import { currentIdentity } from './auth'
import { HttpError } from './security'

type Attachment = { userId: string; name: string; workspaceId: string; sessionHash: string; expiresAt: number; lastTyping: number }
export class WorkspaceHub extends DurableObject<Env> {
  private huddleQueue: Promise<unknown> = Promise.resolve()
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)')
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
    this.presence()
    return new Response(null, { status: 101, webSocket: client })
  }
  emit(event: LiveEvent) {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment
      if (attachment.expiresAt < Date.now()) { ws.close(AUTH_SESSION_CLOSE_CODE, 'Session expired'); continue }
      try { ws.send(JSON.stringify(event)) } catch { /* Reconnect fetches D1 history. */ }
    }
  }
  presence() {
    const users = new Set<string>()
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment
      if (ws.readyState === 1 && a.expiresAt > Date.now()) users.add(a.userId)
    }
    this.emit({ type: 'presence', users: [...users] })
  }
  revokeSession(hash: string) {
    for (const ws of this.ctx.getWebSockets()) if ((ws.deserializeAttachment() as Attachment).sessionHash === hash) ws.close(AUTH_SESSION_CLOSE_CODE, 'Signed out')
    this.presence()
  }
  revokeUser(userId: string) {
    for (const ws of this.ctx.getWebSockets()) if ((ws.deserializeAttachment() as Attachment).userId === userId) ws.close(AUTH_SESSION_CLOSE_CODE, 'Access ended')
    this.presence()
  }
  removeMember(workspaceId: string, actorId: string, userId: string, ban: boolean) {
    const result = this.huddleQueue.then(async () => {
      try {
        await requireServerOwner(this.env, actorId, workspaceId)
        const target = await requireMembership(this.env, userId, workspaceId)
        if (target.role === 'owner') throw new HttpError(403, 'The server owner cannot be removed or banned')
        const calls = await this.env.DB.prepare('SELECT p.id, p.channel_id AS channelId FROM huddle_participants p JOIN channels c ON c.id = p.channel_id WHERE p.user_id = ? AND c.workspace_id = ?').bind(userId, workspaceId).all<{ id: string; channelId: string }>()
        // Stop provider access first; a failed provider removal leaves membership
        // intact and returns an actionable error instead of claiming a full ban.
        for (const call of calls.results) await leaveHuddle(this.env, call.channelId, call.id, userId)
        const db = database(this.env)
        if (ban) await db.batch([
          db.insert(workspaceBans).values({ workspaceId, userId, createdAt: Date.now() }).onConflictDoNothing(),
          db.delete(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId))),
        ])
        else await db.delete(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId))).run()
        this.revokeUser(userId)
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
    if (event.data.threadId && !await database(this.env).select({ id: threads.id }).from(threads).where(and(eq(threads.id, event.data.threadId), eq(threads.channelId, channel.id))).get()) return
    a.lastTyping = Date.now(); ws.serializeAttachment(a)
    this.emit({ type: 'typing', userId: a.userId, name: a.name, channelId: channel.id, ...(event.data.threadId ? { threadId: event.data.threadId } : {}) })
  }
  override async webSocketClose(ws: WebSocket, code: number, reason: string) {
    ws.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, reason)
    this.presence()
  }
  override async webSocketError(ws: WebSocket) { ws.close(4002, 'Connection error'); this.presence() }
  joinHuddle(channelId: string, title: string, user: User) {
    // Serializes creation across concurrent joins without blocking unrelated chat events.
    const result = this.huddleQueue.then(async () => {
      try {
        const channel = await database(this.env).select().from(channels).where(eq(channels.id, channelId)).get()
        if (!channel) throw new HttpError(404, 'Channel not found')
        await requireMembership(this.env, user.id, channel.workspaceId)
        return { ok: true as const, ...await joinHuddle(this.env, channelId, title, user) }
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

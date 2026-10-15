import { drizzle } from 'drizzle-orm/d1'
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import * as schema from '../db/schema'
import type { Message, Thread, User } from '../shared/contracts'
import { HttpError } from './security'
import { authUsers, authAccounts } from '../db/auth-schema'
import { publicProfileName, publicProfileAvatar, telegramProfileJoin } from './user-profiles'

export const database = (env: Env) => drizzle(env.DB, { schema })
export async function requireMembership(env: Env, userId: string, workspaceId: string) {
  const row = await database(env).select().from(schema.memberships).where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.workspaceId, workspaceId))).get()
  if (!row) throw new HttpError(403, 'You are not a member of this server')
  return row
}
export async function requireChannel(env: Env, user: User, channelId: string) {
  const channel = await database(env).select().from(schema.channels).where(eq(schema.channels.id, channelId)).get()
  if (!channel) throw new HttpError(404, 'Channel not found')
  await requireMembership(env, user.id, channel.workspaceId)
  return channel
}
export async function getThreads(env: Env, channelId: string, threadId?: string, parentIds?: string[]): Promise<Thread[]> {
  if (parentIds && !parentIds.length) return []
  if (parentIds && parentIds.length > 80) {
    const rows: Thread[] = []
    for (let i = 0; i < parentIds.length; i += 80) rows.push(...await getThreads(env, channelId, threadId, parentIds.slice(i, i + 80)))
    return rows
  }
  return database(env).select({
    id: schema.threads.id, channelId: schema.threads.channelId, parentMessageId: schema.threads.parentMessageId,
    name: schema.threads.name, authorId: schema.threads.authorId, createdAt: schema.threads.createdAt,
    messageCount: count(schema.messages.id),
  }).from(schema.threads).leftJoin(schema.messages, eq(schema.messages.threadId, schema.threads.id))
    .where(and(eq(schema.threads.channelId, channelId), threadId ? eq(schema.threads.id, threadId) : undefined,
    parentIds ? inArray(schema.threads.parentMessageId, parentIds) : undefined)).groupBy(schema.threads.id).orderBy(desc(schema.threads.createdAt)).limit(100).all()
}
export async function requireThread(env: Env, channelId: string, threadId: string) {
  const thread = (await getThreads(env, channelId, threadId))[0]
  if (!thread) throw new HttpError(404, 'Thread not found')
  return thread
}
export async function getMessages(env: Env, channelId: string, userId: string, messageId?: string, focusId?: string, threadId?: string): Promise<Message[]> {
  const db = database(env)
  const context = and(eq(schema.messages.channelId, channelId), threadId ? eq(schema.messages.threadId, threadId) : isNull(schema.messages.threadId))
  const focus = focusId ? await db.select().from(schema.messages).where(and(eq(schema.messages.id, focusId), context)).get() : undefined
  if (focusId && !focus) throw new HttpError(404, 'Message not found')
  const rows = await db.select({
    id: schema.messages.id, channelId: schema.messages.channelId, authorId: schema.messages.authorId,
    author: publicProfileName, avatarUrl: publicProfileAvatar, color: schema.users.color, role: schema.users.role,
    text: schema.messages.text, createdAt: schema.messages.createdAt, editedAt: schema.messages.editedAt,
    replyToId: schema.messages.replyToId, threadId: schema.messages.threadId,
  }).from(schema.messages).innerJoin(schema.users, eq(schema.users.id, schema.messages.authorId))
    .leftJoin(authUsers, eq(authUsers.id, schema.users.id)).leftJoin(authAccounts, telegramProfileJoin)
    .where(messageId ? and(eq(schema.messages.channelId, channelId), eq(schema.messages.id, messageId)) : context)
    .orderBy(focus ? sql`abs(${schema.messages.createdAt} - ${focus.createdAt})` : desc(schema.messages.createdAt), desc(schema.messages.id)).limit(100).all()
  const reactions = rows.length ? await db.select().from(schema.reactions).where(inArray(schema.reactions.messageId, rows.map((row) => row.id))).all() : []
  const replyIds = [...new Set(rows.flatMap((row) => row.replyToId ? [row.replyToId] : []))]
  const replies: { id: string; authorId: string; author: string; text: string; threadId: string | null }[] = []
  for (let i = 0; i < replyIds.length; i += 80) replies.push(...await db.select({ id: schema.messages.id, authorId: schema.users.id, author: publicProfileName, text: schema.messages.text, threadId: schema.messages.threadId })
    .from(schema.messages).innerJoin(schema.users, eq(schema.users.id, schema.messages.authorId))
    .leftJoin(authUsers, eq(authUsers.id, schema.users.id)).leftJoin(authAccounts, telegramProfileJoin)
    .where(and(eq(schema.messages.channelId, channelId), inArray(schema.messages.id, replyIds.slice(i, i + 80)))).all())
  const threads = await getThreads(env, channelId, undefined, rows.map((row) => row.id))
  const files: { id: string; name: string; size: number; contentType: string; messageId: string | null }[] = []
  for (let i = 0; i < rows.length; i += 80) files.push(...await db.select({ id: schema.attachments.id, name: schema.attachments.name, size: schema.attachments.size, contentType: schema.attachments.contentType, messageId: schema.attachments.messageId }).from(schema.attachments).where(inArray(schema.attachments.messageId, rows.slice(i, i + 80).map(r => r.id))).all())
  return rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map(({ role, ...row }) => {
    const grouped = new Map<string, { emoji: string; count: number; mine: boolean }>()
    for (const reaction of reactions.filter((r) => r.messageId === row.id)) {
      const group = grouped.get(reaction.emoji) || { emoji: reaction.emoji, count: 0, mine: false }
      group.count++; group.mine ||= reaction.userId === userId
      grouped.set(reaction.emoji, group)
    }
    const source = replies.find((reply) => reply.id === row.replyToId && reply.threadId === row.threadId)
    const thread = threads.find((item) => item.parentMessageId === row.id)
    return { ...row, author: row.authorId === 'system' ? 'Anycord' : row.author, attachments: files.filter(f => f.messageId === row.id).map(({ messageId, ...file }) => file), bot: role === 'bot', reactions: Array.from(grouped.values()),
      reply: source ? { id: source.id, author: source.authorId === 'system' ? 'Anycord' : source.author, text: source.text.slice(0, 240) || '[Attachment]' } : null,
      thread: thread ? { id: thread.id, name: thread.name, messageCount: thread.messageCount } : null }
  })
}
export async function getSetting(env: Env, key: string) {
  return (await database(env).select().from(schema.settings).where(eq(schema.settings.key, key)).get())?.value || ''
}
export async function setSetting(env: Env, key: string, value: string) {
  await database(env).insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } }).run()
}

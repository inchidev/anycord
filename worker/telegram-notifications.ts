import { canReadChannel } from './permissions'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { authAccounts } from '../db/auth-schema'
import { messages, telegramPreferences, telegramOutbox, threadFollowers } from '../db/schema'
import type { Message } from '../shared/contracts'
import { telegramPreferencesInputSchema } from '../shared/contracts'
import { serverPath } from '../shared/navigation'
import { authenticationConfig, authenticationMethods, botRequest, TelegramRequestError } from './authentication'
import { database, getSetting } from './store'
import { HttpError } from './security'

export async function telegramAccount(env: Env, userId: string) {
  const db = database(env), config = await authenticationConfig(env)
  const accounts = await db.select().from(authAccounts).where(eq(authAccounts.userId, userId)).all()
  const prefs = await db.select().from(telegramPreferences).where(eq(telegramPreferences.userId, userId)).get()
  const password = accounts.some(account => account.providerId === 'credential' && !!account.password)
  return { linked: accounts.some(account => account.providerId === 'telegram'), canUnlink: password && config.passwordLogin,
    canSetPassword: !password, botUsername: config.botUsername, notificationsAvailable: config.notifications && !!config.botToken,
    messagingAllowed: prefs?.messagingAllowed || false, enabled: prefs?.enabled || false, preview: prefs?.preview || false,
    mutedChannelIds: z.array(z.string()).parse(JSON.parse(prefs?.mutedChannelIds || '[]')),
    browserLogin: authenticationMethods(config).telegramLogin, miniAppLogin: authenticationMethods(config).miniAppLogin }
}
export async function updateTelegramPreferences(env: Env, userId: string, input: z.infer<typeof telegramPreferencesInputSchema>) {
  const status = await telegramAccount(env, userId)
  if (input.enabled && (!status.linked || !status.notificationsAvailable || !status.messagingAllowed)) throw new HttpError(409, 'Link Telegram and start the configured bot before enabling notifications')
  // Preferences are not a grant: delivery re-checks channel membership.
  const values = { ...input, userId, mutedChannelIds: JSON.stringify([...new Set(input.mutedChannelIds)]) }
  await database(env).insert(telegramPreferences).values(values).onConflictDoUpdate({ target: telegramPreferences.userId, set: values }).run()
  if (!input.enabled) await database(env).delete(telegramOutbox).where(eq(telegramOutbox.userId, userId)).run()
  return telegramAccount(env, userId)
}
export async function unlinkTelegram(env: Env, userId: string) {
  const snapshot = await getSetting(env, 'authentication')
  const status = await telegramAccount(env, userId)
  if (!status.linked) return
  if (!status.canUnlink) throw new HttpError(409, 'Set a username/password and enable password login before unlinking Telegram')
  const result = await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_account WHERE user_id = ? AND provider_id = 'telegram' AND (SELECT value FROM settings WHERE key = 'authentication') = ?").bind(userId, snapshot),
    env.DB.prepare("DELETE FROM telegram_preferences WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM auth_account WHERE user_id = ? AND provider_id = 'telegram')").bind(userId, userId),
    env.DB.prepare("DELETE FROM telegram_outbox WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM auth_account WHERE user_id = ? AND provider_id = 'telegram')").bind(userId, userId),
  ])
  if (!result[0]!.meta.changes) throw new HttpError(409, 'Authentication settings changed. Refresh before unlinking Telegram.')
}
export async function telegramWebhook(env: Env, input: unknown) {
  const update = z.object({
    message: z.object({ text: z.string().optional(), from: z.object({ id: z.number().int().positive() }).optional(), chat: z.object({ id: z.number().int(), type: z.string() }) }).optional(),
    my_chat_member: z.object({ chat: z.object({ id: z.number().int(), type: z.string() }), new_chat_member: z.object({ status: z.string() }) }).optional(),
  }).parse(input)
  const message = update.message, membership = update.my_chat_member
  const chat = message?.chat || membership?.chat
  if (!chat || chat.type !== 'private') return
  const start = !!message && message.from?.id === chat.id && /^\/start(?:\s|$)/.test(message.text || '')
  const stop = (!!message && message.from?.id === chat.id && /^\/stop(?:\s|$)/.test(message.text || '')) || ['kicked', 'left'].includes(membership?.new_chat_member.status || '')
  if (!start && !stop) return
  const db = database(env)
  const account = await db.select().from(authAccounts).where(and(eq(authAccounts.providerId, 'telegram'), eq(authAccounts.accountId, String(chat.id)))).get()
  if (!account) return
  await db.insert(telegramPreferences).values({ userId: account.userId, messagingAllowed: start }).onConflictDoUpdate({ target: telegramPreferences.userId,
    set: start ? { messagingAllowed: true } : { messagingAllowed: false, enabled: false } }).run()
  if (stop) await db.delete(telegramOutbox).where(eq(telegramOutbox.userId, account.userId)).run()
}
export function mentionsUser(text: string, name: string) {
  // Explicit @username text; no display-name guessing or @everyone broadcast.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\s)@${escaped}(?=$|[\\s.,!?:;])`, 'iu').test(text)
}
export async function queueTelegramNotifications(env: Env, workspaceId: string, message: Message) {
  const config = await authenticationConfig(env)
  if (!config.notifications || !config.botToken) return
  const recipients = await env.DB.prepare(`SELECT p.user_id AS userId, u.name FROM telegram_preferences p
    JOIN users u ON u.id = p.user_id JOIN memberships m ON m.user_id = p.user_id
    JOIN auth_account a ON a.user_id = p.user_id AND a.provider_id = 'telegram'
    WHERE m.workspace_id = ? AND p.enabled = 1 AND p.messaging_allowed = 1 AND p.user_id != ?
    AND NOT EXISTS (SELECT 1 FROM workspace_bans b WHERE b.user_id = p.user_id AND b.workspace_id = m.workspace_id)`).bind(workspaceId, message.authorId).all<{ userId: string; name: string }>()
  const db = database(env)
  const reply = message.replyToId ? await db.select().from(messages).where(eq(messages.id, message.replyToId)).get() : null
  const followers = message.threadId ? await db.select().from(threadFollowers).where(eq(threadFollowers.threadId, message.threadId)).all() : []
  const values = recipients.results.filter(recipient => recipient.userId === reply?.authorId || followers.some(f => f.userId === recipient.userId) || mentionsUser(message.text, recipient.name))
    .map(recipient => ({ id: `${message.id}:${recipient.userId}`, userId: recipient.userId, messageId: message.id, dueAt: Date.now() }))
  for (let i = 0; i < values.length; i += 10) await db.insert(telegramOutbox).values(values.slice(i, i + 10)).onConflictDoNothing().run()
}
export async function flushTelegramNotifications(env: Env) {
  const config = await authenticationConfig(env)
  if (!config.notifications || !config.botToken) return
  // A timed-out/crashed delivery is ambiguous; don't resend it automatically.
  await env.DB.prepare("UPDATE telegram_outbox SET status = 'failed' WHERE status = 'sending' AND due_at < ?").bind(Date.now() - 60_000).run()
  const rows = await env.DB.prepare("SELECT id FROM telegram_outbox WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 10").bind(Date.now()).all<{ id: string }>()
  await Promise.all(rows.results.map(async row => {
    const claimed = await env.DB.prepare("UPDATE telegram_outbox SET status = 'sending', attempts = attempts + 1, due_at = ? WHERE id = ? AND status = 'pending' RETURNING user_id AS userId, message_id AS messageId, attempts").bind(Date.now(), row.id).first<{ userId: string; messageId: string; attempts: number }>()
    if (!claimed) return
    let status = 'sent', dueAt = Date.now()
    try {
      const delivery = await env.DB.prepare(`SELECT p.enabled, p.preview, p.messaging_allowed AS allowed, p.muted_channel_ids AS muted,
        a.account_id AS chatId, c.id AS channelId, c.name AS channel, c.workspace_id AS workspaceId, msg.text, msg.thread_id AS threadId,
        u.name AS recipientName, reply.author_id AS replyAuthorId,
        EXISTS (SELECT 1 FROM thread_followers f WHERE f.user_id = p.user_id AND f.thread_id = msg.thread_id) AS following
        FROM telegram_preferences p JOIN auth_account a ON a.user_id = p.user_id AND a.provider_id = 'telegram'
        JOIN messages msg ON msg.id = ? JOIN channels c ON c.id = msg.channel_id
        JOIN users u ON u.id = p.user_id LEFT JOIN messages reply ON reply.id = msg.reply_to_id
        JOIN memberships m ON m.workspace_id = c.workspace_id AND m.user_id = p.user_id WHERE p.user_id = ?
        AND NOT EXISTS (SELECT 1 FROM workspace_bans b WHERE b.user_id = p.user_id AND b.workspace_id = c.workspace_id)`).bind(claimed.messageId, claimed.userId)
        .first<{ enabled: number; preview: number; allowed: number; muted: string; chatId: string; channelId: string; channel: string; workspaceId: string; text: string; threadId: string | null; recipientName: string; replyAuthorId: string | null; following: number }>()
      if (!delivery?.enabled || !delivery.allowed || z.array(z.string()).parse(JSON.parse(delivery.muted)).includes(delivery.channelId)
        || !(delivery.replyAuthorId === claimed.userId || delivery.following || mentionsUser(delivery.text, delivery.recipientName))) { status = 'skipped' }
      else if (!await canReadChannel(env, claimed.userId, delivery.channelId)) status = 'skipped'
      else {
        const link = new URL(serverPath(delivery.workspaceId, delivery.channelId), env.AUTH_BASE_URL)
        if (delivery.threadId) link.searchParams.set('thread', delivery.threadId)
        link.hash = `message-${claimed.messageId}`
        // Re-read global enablement immediately before using a cached credential.
        const active = await authenticationConfig(env)
        if (!active.notifications || active.botToken !== config.botToken) status = 'skipped'
        else await botRequest(config, 'sendMessage', { chat_id: delivery.chatId,
          text: `New activity in #${delivery.channel}${delivery.preview ? `\n${delivery.text.slice(0, 500)}` : ''}\n${link.href}`,
          link_preview_options: { is_disabled: true } })
      }
    } catch (error) {
      status = 'failed'
      if (error instanceof TelegramRequestError && error.status === 403) await env.DB.prepare('UPDATE telegram_preferences SET enabled = 0, messaging_allowed = 0 WHERE user_id = ?').bind(claimed.userId).run()
      if (error instanceof TelegramRequestError && error.retryable && claimed.attempts < 3) { status = 'pending'; dueAt += Math.max(error.retryAfter * 1000, claimed.attempts * 60_000) }
      console.warn(JSON.stringify({ event: 'telegram_delivery_failed', retry: status === 'pending' }))
    }
    await env.DB.prepare('UPDATE telegram_outbox SET status = ?, due_at = ? WHERE id = ?').bind(status, dueAt, row.id).run()
  }))
  await env.DB.prepare("DELETE FROM telegram_outbox WHERE status IN ('sent', 'failed', 'skipped') AND due_at < ?").bind(Date.now() - 7 * 86400_000).run()
}
export async function testTelegramNotification(env: Env, userId: string) {
  const status = await telegramAccount(env, userId)
  if (!status.linked || !status.enabled || !status.messagingAllowed || !status.notificationsAvailable) throw new HttpError(409, 'Enable Telegram notifications and start the bot before sending a test')
  const account = await database(env).select().from(authAccounts).where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, 'telegram'))).get()
  if (!account) throw new HttpError(409, 'Link Telegram first')
  await botRequest(await authenticationConfig(env), 'sendMessage', { chat_id: account.accountId, text: 'Telegram notifications are connected to your Anycord account.' })
}

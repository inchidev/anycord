import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { authenticationInputSchema, telegramIntegrationInputSchema } from '../shared/contracts'
import { authAccounts } from '../db/auth-schema'
import { database, getSetting } from './store'
import { decrypt, encrypt, HttpError } from './security'

const configSchema = authenticationInputSchema.extend({
  botToken: z.string().default(''), botId: z.string().default(''), botUsername: z.string().default(''),
  clientId: z.string().default(''), clientSecret: z.string().default(''),
  notifications: z.boolean().default(false), webhookSecret: z.string().default(''),
  revision: z.number().int().nonnegative().default(0),
})
export type AuthenticationConfig = z.infer<typeof configSchema>
export async function authenticationConfig(env: Env): Promise<AuthenticationConfig> {
  const saved = await getSetting(env, 'authentication')
  return configSchema.parse(saved ? JSON.parse(await decrypt(saved, env.APP_SECRET)) : {})
}
async function persistConfig(env: Env, config: AuthenticationConfig) {
  const previous = await getSetting(env, 'authentication')
  const revision = previous ? configSchema.parse(JSON.parse(await decrypt(previous, env.APP_SECRET))).revision : 0
  if (revision !== config.revision) throw new HttpError(409, 'Authentication settings changed. Refresh and try again.')
  const encrypted = await encrypt(JSON.stringify({ ...config, revision: revision + 1 }), env.APP_SECRET)
  const saved = await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('authentication', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE settings.value = ? AND (? = 1 OR EXISTS (SELECT 1 FROM users u JOIN auth_account a ON a.user_id = u.id WHERE u.role = 'owner' AND a.provider_id = 'telegram')) RETURNING key`)
    .bind(encrypted, previous, Number(config.passwordLogin)).first()
  if (!saved) throw new HttpError(409, 'Authentication settings changed. Refresh and try again.')
}
export async function initialized(env: Env) {
  return !!await env.DB.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").first()
}
export function authenticationMethods(config: AuthenticationConfig) {
  return { passwordLogin: config.passwordLogin, registration: config.registration,
    telegramLogin: config.telegramLogin && !!(config.clientId && config.clientSecret),
    miniAppLogin: config.miniAppLogin && !!config.botToken }
}
export async function authenticationStatus(env: Env) {
  return authenticationMethods(await authenticationConfig(env))
}
export function telegramStatus(env: Env, config: AuthenticationConfig) {
  const origin = new URL(env.AUTH_BASE_URL).origin
  return { botConfigured: !!config.botToken, botUsername: config.botUsername, clientId: config.clientId,
    oidcConfigured: !!(config.clientId && config.clientSecret), notifications: config.notifications,
    origin, callbackURL: `${origin}/api/auth/callback/telegram`, miniAppURL: `${origin}/login`,
    webhookURL: `${origin}/api/telegram/webhook` }
}
async function saveConfig(env: Env, config: AuthenticationConfig, ownerId: string) {
  const methods = authenticationMethods(config)
  if (config.telegramLogin && !methods.telegramLogin) throw new HttpError(400, 'Configure Telegram OIDC credentials first')
  if (config.miniAppLogin && !methods.miniAppLogin) throw new HttpError(400, 'Configure a Telegram bot first')
  // Keep a browser-accessible recovery method for the installation owner.
  if (!methods.passwordLogin) {
    const linked = await database(env).select().from(authAccounts).where(and(eq(authAccounts.userId, ownerId), eq(authAccounts.providerId, 'telegram'))).get()
    if (!methods.telegramLogin || !linked?.accessToken) throw new HttpError(409, 'Verify browser Telegram login with your owner account before disabling password login')
  }
  if (config.notifications && !config.botToken) throw new HttpError(400, 'Configure a bot before enabling Telegram notifications')
  await persistConfig(env, config)
}
export async function updateAuthentication(env: Env, ownerId: string, input: z.infer<typeof authenticationInputSchema>) {
  const config = { ...await authenticationConfig(env), ...input }
  await saveConfig(env, config, ownerId)
  return authenticationMethods(config)
}
const botResult = z.object({ id: z.number().int().positive(), username: z.string().regex(/^[A-Za-z0-9_]+$/), is_bot: z.literal(true) })
export class TelegramRequestError extends HttpError {
  constructor(status: number, public retryable: boolean, public retryAfter = 60) { super(status, 'Telegram rejected the request. Check the bot token, permissions and chat access.') }
}
export async function botRequest(config: AuthenticationConfig, method: string, body: unknown) {
  let response: Response
  try {
    response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    })
  } catch { throw new HttpError(502, 'Telegram is unavailable. Try again later.') }
  const result = z.object({ ok: z.boolean(), result: z.unknown().optional(), parameters: z.object({ retry_after: z.number().optional() }).optional() }).safeParse(await response.json().catch(() => null))
  if (!response.ok || !result.success || !result.data.ok) throw new TelegramRequestError(response.status === 403 ? 403 : 502,
    result.success && !result.data.ok && (response.status === 429 || response.status >= 500), result.success ? result.data.parameters?.retry_after : undefined)
  return result.data.result
}
export async function updateTelegramIntegration(env: Env, ownerId: string, input: z.infer<typeof telegramIntegrationInputSchema>) {
  const previous = await authenticationConfig(env)
  const config = { ...previous, clientId: input.clientId, notifications: input.notifications }
  if (input.botToken !== undefined) {
    config.botToken = input.botToken
    if (input.botToken) {
      const bot = botResult.parse(await botRequest(config, 'getMe', {}))
      if (previous.botId && String(bot.id) !== previous.botId) throw new HttpError(409, 'Remove the old bot before configuring a different bot')
      config.botId = String(bot.id); config.botUsername = bot.username
    } else {
      if (!config.passwordLogin) throw new HttpError(409, 'Enable password login before removing Telegram credentials')
      config.botId = ''; config.botUsername = ''; config.miniAppLogin = false; config.notifications = false
      config.webhookSecret = ''
    }
  }
  if (input.clientSecret !== undefined) config.clientSecret = input.clientSecret
  const oidcChanged = config.clientId !== previous.clientId || config.clientSecret !== previous.clientSecret
  if (oidcChanged) {
    if (!previous.passwordLogin) throw new HttpError(409, 'Enable password login before changing OIDC credentials')
    // Require another successful browser login after credential changes. Clear
    // proof while password login is still available, before saving new secrets.
    await database(env).update(authAccounts).set({ accessToken: null, idToken: null }).where(eq(authAccounts.providerId, 'telegram')).run()
  }
  if (!config.clientId || !config.clientSecret) config.telegramLogin = false
  if (config.botId && config.clientId && config.botId !== config.clientId) throw new HttpError(400, 'The OIDC Client ID and bot token must belong to the same bot')
  await saveConfig(env, config, ownerId)
  if (!config.botToken) await env.DB.batch([env.DB.prepare('DELETE FROM telegram_preferences'), env.DB.prepare('DELETE FROM telegram_outbox')])
  return telegramStatus(env, config)
}
export async function configureTelegramWebhook(env: Env) {
  const config = await authenticationConfig(env)
  if (!config.botToken) throw new HttpError(409, 'Save a bot token first')
  if (new URL(env.AUTH_BASE_URL).protocol !== 'https:') throw new HttpError(409, 'Telegram webhooks need a public HTTPS installation URL')
  const webhookSecret = config.webhookSecret || crypto.randomUUID()
  // Save before the remote request, so a timeout/retry cannot lose the verification secret.
  await persistConfig(env, { ...config, webhookSecret })
  await botRequest(config, 'setWebhook', { url: telegramStatus(env, config).webhookURL, secret_token: webhookSecret, allowed_updates: ['message', 'my_chat_member'] })
}

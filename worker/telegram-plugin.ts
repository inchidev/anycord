import { z } from 'zod'
import { genericOAuth } from 'better-auth/plugins/generic-oauth'
import { APIError, createAuthEndpoint, getSessionFromCtx } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { decodeJwt } from 'jose'
import { authenticationConfig, initialized, type AuthenticationConfig } from './authentication'
import { authAccounts } from '../db/auth-schema'
import { drizzle } from 'drizzle-orm/d1'
import { and, eq } from 'drizzle-orm'
import { applyTelegramProfile } from './user-profiles'
import { profileImage } from '../shared/profile'

const telegramIdSchema = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9]\d{0,15}$/)]).transform(String)
export function telegramProfile(profile: Record<string, unknown>) {
  // OIDC sub is not the Bot API user ID. Only the signed `id` claim can
  // converge with Mini App user.id and address the corresponding bot chat.
  const id = telegramIdSchema.parse(profile.id)
  const name = (typeof profile.name === 'string' ? profile.name : 'Telegram').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 100) || 'Telegram'
  return { id, name, image: profileImage(profile.picture),
    email: `telegram-${id}@identity.anycord.invalid`, emailVerified: false }
}
export function telegramOIDC(env: Env, config?: AuthenticationConfig) {
  return genericOAuth({ config: config ? [{
    providerId: 'telegram', name: 'Telegram', clientId: config.clientId, clientSecret: config.clientSecret,
    discoveryUrl: 'https://oauth.telegram.org/.well-known/openid-configuration', requireIdTokenVerification: true,
    scopes: ['openid', 'profile'], pkce: true, authentication: 'basic', disableSignUp: !config.registration,
    accountSubject: ({ profile }) => telegramProfile(profile).id,
    getUserInfo: async (tokens) => {
      // Generic OAuth verifies the JWT (including nonce) before calling this mapper.
      if (!tokens.idToken) return null
      const claims = decodeJwt<Record<string, unknown>>(tokens.idToken)
      const profile = telegramProfile(claims)
      const account = await drizzle(env.DB).select().from(authAccounts).where(and(eq(authAccounts.providerId, 'telegram'), eq(authAccounts.accountId, profile.id))).get()
      if (account) await applyTelegramProfile(env, account.userId, profile)
      return { ...claims, email: telegramProfile(claims).email, emailVerified: false }
    },
    mapProfileToUser: profile => { const { id, image, ...user } = telegramProfile(profile); return { ...user, ...(image ? { image } : {}) } },
  }] : [] })
}

const miniAppUser = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), first_name: z.string().min(1).max(100), last_name: z.string().max(100).optional(), photo_url: z.string().max(2048).optional() })
export function miniAppProfile(telegram: z.infer<typeof miniAppUser>) {
  return telegramProfile({ id: telegram.id, name: [telegram.first_name, telegram.last_name].filter(Boolean).join(' '), picture: telegram.photo_url })
}
export async function verifyMiniAppData(raw: string, botToken: string, now = Date.now()) {
  const params = new URLSearchParams(raw)
  const seen = new Set<string>()
  for (const [key] of params) { if (seen.has(key)) throw new Error('Duplicate Mini App field'); seen.add(key) }
  const hash = params.get('hash') || '', date = Number(params.get('auth_date'))
  if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(date) || date > now / 1000 + 30 || now / 1000 - date > 300) throw new Error('Expired or invalid Mini App data')
  params.delete('hash')
  const encoder = new TextEncoder()
  const hmac = async (key: Uint8Array, data: string) => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), encoder.encode(data)))
  const secret = await hmac(encoder.encode('WebAppData'), botToken)
  const expected = await hmac(secret, [...params].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n'))
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected[i]! ^ parseInt(hash.slice(i * 2, i * 2 + 2), 16)
  if (diff) throw new Error('Invalid Mini App signature')
  return miniAppUser.parse(JSON.parse(params.get('user') || 'null'))
}
export function telegramMiniApp(env: Env) {
  return {
    id: 'anycord-telegram',
    endpoints: {
      telegramMiniApp: createAuthEndpoint('/telegram/miniapp', {
        method: 'POST', body: z.object({ initData: z.string().min(1).max(16_000), link: z.boolean().default(false) }), requireHeaders: true,
      }, async ctx => {
        const config = await authenticationConfig(env)
        if (!config.miniAppLogin || !config.botToken || !await initialized(env)) throw new APIError('FORBIDDEN', { message: 'Mini App login is unavailable' })
        let telegram: z.infer<typeof miniAppUser>
        try { telegram = await verifyMiniAppData(ctx.body.initData, config.botToken) }
        catch { throw new APIError('UNAUTHORIZED', { message: 'Telegram login expired or could not be verified. Reopen the Mini App.' }) }
        const adapter = ctx.context.internalAdapter
        const key = { providerId: 'telegram', accountId: String(telegram.id) }
        const current = await getSessionFromCtx(ctx)
        const owner = await adapter.findAccountOwnerByKey(key)
        if (owner?.kind === 'orphaned') throw new APIError('CONFLICT', { message: 'Telegram account needs recovery' })
        if (ctx.body.link && !current) throw new APIError('UNAUTHORIZED', { message: 'Sign in before linking Telegram' })
        if (current && owner?.kind === 'owned' && owner.user.id !== current.user.id) throw new APIError('CONFLICT', { message: 'This Telegram account belongs to a different Anycord account' })
        if (current && !ctx.body.link && !owner) throw new APIError('CONFLICT', { message: 'Link Telegram explicitly in User Settings' })
        if (current && ctx.body.link) {
          if (Date.now() - new Date(current.session.createdAt).getTime() > 600_000) throw new APIError('FORBIDDEN', { message: 'Sign in again before linking Telegram' })
          const existing = (await adapter.findAccounts(current.user.id)).find(account => account.providerId === 'telegram')
          if (existing && existing.accountId !== key.accountId) throw new APIError('CONFLICT', { message: 'Unlink the previous Telegram account first' })
          if (!owner) await adapter.linkAccount({ ...key, userId: current.user.id })
          await applyTelegramProfile(env, current.user.id, miniAppProfile(telegram))
          return ctx.json({ ok: true })
        }
        let user = owner?.user
        if (!user) {
          if (!config.registration) throw new APIError('FORBIDDEN', { message: 'Registration is closed on this installation' })
          const { id, ...profile } = miniAppProfile(telegram)
          user = (await adapter.createOAuthUser(profile, key)).user
        }
        else await applyTelegramProfile(env, user.id, miniAppProfile(telegram))
        if (current) return ctx.json({ ok: true })
        const session = await adapter.createSession(user.id)
        await setSessionCookie(ctx, { user, session })
        return ctx.json({ ok: true })
      }),
    },
  }
}

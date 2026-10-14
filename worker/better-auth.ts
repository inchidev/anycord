import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { bearer } from 'better-auth/plugins/bearer'
import { username } from 'better-auth/plugins/username'
import { APIError, createAuthEndpoint } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { hashPassword as betterHash, verifyPassword as betterVerify } from 'better-auth/crypto'
import { drizzle } from 'drizzle-orm/d1'
import { and, eq, gt } from 'drizzle-orm'
import { authUsers, authSessions, authAccounts, authVerifications } from '../db/auth-schema'
import { sessions, users, memberships } from '../db/schema'
import { database } from './store'
import { digest, verifyPassword as legacyVerify } from './security'
import { authenticationConfig, initialized, type AuthenticationConfig } from './authentication'
import { telegramMiniApp, telegramOIDC } from './telegram-plugin'
import { userProfile } from './user-profiles'

function legacyToken(headers: Headers | undefined) { return headers?.get('cookie')?.match(/(?:^|;\s*)cellcord_session=([a-f0-9]{64})/)?.[1] || '' }
export async function ensureProfile(env: Env, identity: { id: string; name: string; username?: string | null; email?: string }) {
  const existing = await userProfile(env, identity.id)
  if (existing) return existing
  const color = ['#5865f2', '#57f287', '#eb459e', '#fee75c', '#2dc4c4', '#f79356'][parseInt((await digest(identity.id)).slice(0, 2), 16) % 6] || '#5865f2'
  const telegramId = identity.email?.match(/^telegram-([1-9]\d{0,15})@identity\.anycord\.invalid$/)?.[1]
  const handle = identity.username || (telegramId ? `${identity.name.toLowerCase()} · tg:${telegramId}` : identity.name.toLowerCase())
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO users (id, name, password_hash, color, role, created_at) SELECT ?, ?, 'disabled', ?, CASE WHEN EXISTS (SELECT 1 FROM users WHERE role = 'owner') THEN 'member' ELSE 'owner' END, ?").bind(identity.id, handle, color, Date.now()),
    env.DB.prepare("INSERT OR IGNORE INTO memberships (user_id, workspace_id, role) SELECT id, 'main', CASE WHEN role = 'owner' THEN 'owner' ELSE 'member' END FROM users WHERE id = ?").bind(identity.id),
  ])
  return userProfile(env, identity.id)
}
export async function revokeLiveSession(env: Env, token: string, userId: string) {
  const rows = await database(env).select().from(memberships).where(eq(memberships.userId, userId)).all()
  const hash = await digest(token)
  await Promise.all(rows.map((row) => env.HUBS.getByName(row.workspaceId).revokeSession(hash).catch(() => {
    console.warn(JSON.stringify({ event: 'live_session_revoke_failed', workspaceId: row.workspaceId }))
  })))
}
export function createAuth(env: Env, oidc?: AuthenticationConfig) {
  const db = drizzle(env.DB)
  return betterAuth({
    appName: 'Anycord', secret: env.APP_SECRET,
    baseURL: env.AUTH_BASE_URL, basePath: '/api/auth',
    trustedOrigins: [env.AUTH_BASE_URL],
    telemetry: { enabled: false },
    logger: { disabled: true },
    database: drizzleAdapter(db, { provider: 'sqlite', transaction: false, schema: { user: authUsers, session: authSessions, account: authAccounts, verification: authVerifications } }),
    advanced: { cookiePrefix: 'cellcord', useSecureCookies: env.AUTH_BASE_URL.startsWith('https:'), database: { generateId: () => crypto.randomUUID() },
      // Telegram Web embeds Mini Apps. Partitioned session cookies also keep
      // that session separate from the standalone browser's installation session.
      cookies: env.AUTH_BASE_URL.startsWith('https:') ? { session_token: { attributes: { sameSite: 'none', secure: true, partitioned: true } } } : undefined,
    },
    emailAndPassword: {
      enabled: true, minPasswordLength: 10, maxPasswordLength: 128, requireEmailVerification: false,
      password: {
        hash: betterHash,
        verify: ({ hash, password }) => /^[a-f0-9]{32}:[a-f0-9]{64}$/.test(hash) ? legacyVerify(password, hash) : betterVerify({ hash, password }),
      },
    },
    session: { expiresIn: 7 * 86400, cookieCache: { enabled: false } },
    // Telegram does not supply email. Trust its verified identity for explicit
    // linking only; email/name-based implicit linking stays disabled.
    account: { encryptOAuthTokens: true, accountLinking: { enabled: true, trustedProviders: ['telegram'], disableImplicitLinking: true, allowDifferentEmails: true } },
    databaseHooks: {
      user: { create: {
        before: async (user) => {
          if (await initialized(env) && !(await authenticationConfig(env)).registration) throw new APIError('FORBIDDEN', { message: 'Registration is closed on this installation' })
          return { data: user }
        },
        after: async (user) => { await ensureProfile(env, user) },
      } },
    },
    plugins: [telegramOIDC(env, oidc), telegramMiniApp(env), bearer({ requireSignature: true }), username({ minUsernameLength: 2, maxUsernameLength: 32, displayUsername: false, immutableUsername: true, usernameValidator: (value) => /^[a-zA-Z0-9_ -]+$/.test(value) }), {
      id: 'legacy-session-migration',
      endpoints: {
        migrateLegacySession: createAuthEndpoint('/migrate-legacy-session', { method: 'POST' }, async (ctx) => {
          const token = legacyToken(ctx.headers)
          if (!token) return ctx.json({ migrated: false, user: null })
          const hash = await digest(token)
          const previous = await database(env).select().from(sessions).where(and(eq(sessions.token, hash), gt(sessions.expiresAt, Date.now()))).get()
          if (!previous) return ctx.json({ migrated: false, user: null })
          const identity = await ctx.context.internalAdapter.findUserById(previous.userId)
          if (!identity) return ctx.json({ migrated: false, user: null })
          const session = await ctx.context.internalAdapter.createSession(identity.id, false, { expiresAt: new Date(previous.expiresAt) })
          if (!session) throw new Error('Could not migrate session')
          await setSessionCookie(ctx, { session, user: identity })
          ctx.setCookie('cellcord_session', '', { maxAge: 0, path: '/', httpOnly: true, sameSite: 'strict' })
          await database(env).delete(sessions).where(eq(sessions.token, hash)).run()
          await revokeLiveSession(env, token, previous.userId)
          return ctx.json({ migrated: true, user: await ensureProfile(env, identity) })
        }),
      },
    }],
  })
}

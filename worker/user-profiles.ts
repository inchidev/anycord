import { drizzle } from 'drizzle-orm/d1'
import { and, eq, sql } from 'drizzle-orm'
import { users } from '../db/schema'
import { authUsers, authAccounts } from '../db/auth-schema'
import { profileImage } from '../shared/profile'

export const telegramProfileJoin = and(eq(authAccounts.userId, users.id), eq(authAccounts.providerId, 'telegram'))
const name = sql<string>`coalesce((SELECT name FROM server_apps WHERE bot_user_id = ${users.id}), nullif(${authUsers.name}, ''), ${users.name})`
const telegramId = sql<string>`case when ${authUsers.email} like 'telegram-%@identity.anycord.invalid'
  then substr(${authUsers.email}, 10, instr(${authUsers.email}, '@') - 10) else ${authAccounts.accountId} end`
const suffix = sql<string>`' · tg:' || ${telegramId}`
// Older Telegram accounts put the provider ID in their name. Keep their unique
// internal handle (and mentions/login) intact; remove only that exact suffix
// from presentation, after joining the account belonging to this user.
export const publicProfileName = sql<string>`case when substr(${name}, -length(${suffix})) = ${suffix}
  then substr(${name}, 1, length(${name}) - length(${suffix})) else ${name} end`
export const publicProfileAvatar = sql<string | null>`coalesce((SELECT nullif(avatar_url, '') FROM server_apps WHERE bot_user_id = ${users.id}), ${authUsers.image})`
export const profileColumns = {
  id: users.id, name: publicProfileName, color: users.color, role: users.role,
  avatarUrl: publicProfileAvatar,
  telegram: sql<boolean>`${authAccounts.id} is not null`.mapWith(Boolean),
}

export async function userProfile(env: Env, id: string) {
  return drizzle(env.DB).select(profileColumns).from(users)
    .leftJoin(authUsers, eq(authUsers.id, users.id)).leftJoin(authAccounts, telegramProfileJoin)
    .where(eq(users.id, id)).get()
}

export async function applyTelegramProfile(env: Env, userId: string, profile: { name: string; image: string | null }) {
  const db = drizzle(env.DB)
  const user = await db.select().from(authUsers).where(eq(authUsers.id, userId)).get()
  if (!user) return
  // A password-created account keeps its chosen name when explicitly linking
  // Telegram. Telegram-created profiles use Telegram's current display name.
  const telegramCreated = /^telegram-[1-9]\d{0,15}@identity\.anycord\.invalid$/.test(user.email)
  await db.update(authUsers).set({ ...(telegramCreated ? { name: profile.name } : {}), image: profileImage(profile.image), updatedAt: new Date() })
    .where(eq(authUsers.id, userId)).run()
}

import { hashPassword, verifyPassword } from 'better-auth/crypto'
import { digest, HttpError, verifyPassword as legacyVerify } from './security'
import { requireMembership } from './store'

export function randomToken(bytes = 24) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(v => v.toString(16).padStart(2, '0')).join('')
}
export async function requireServerOwner(env: Env, userId: string, workspaceId: string) {
  if ((await requireMembership(env, userId, workspaceId)).role !== 'owner') throw new HttpError(403, 'Only the server owner can manage invitations and members')
}
export async function generateRecoveryKeys(env: Env, userId: string, password: string) {
  const account = await env.DB.prepare("SELECT password FROM auth_account WHERE user_id = ? AND provider_id = 'credential'").bind(userId).first<{ password: string }>()
  const valid = account?.password && ( /^[a-f0-9]{32}:[a-f0-9]{64}$/.test(account.password)
    ? await legacyVerify(password, account.password) : await verifyPassword({ password, hash: account.password }))
  if (!valid || !account) throw new HttpError(401, 'Current password is incorrect')
  const keys = Array.from({ length: 8 }, () => randomToken(16).match(/.{4}/g)!.join('-'))
  const hashes = await Promise.all(keys.map(key => digest(key.replaceAll('-', ''))))
  // Guard rotation against a concurrent password reset after password verification.
  const guard = "EXISTS (SELECT 1 FROM auth_account WHERE user_id = ? AND provider_id = 'credential' AND password = ?)"
  const result = await env.DB.batch([
    env.DB.prepare(`DELETE FROM recovery_keys WHERE user_id = ? AND ${guard}`).bind(userId, userId, account.password),
    ...hashes.map(hash => env.DB.prepare(`INSERT INTO recovery_keys (hash, user_id, created_at) SELECT ?, ?, ? WHERE ${guard}`).bind(hash, userId, Date.now(), userId, account.password)),
  ])
  if (!result[1]?.meta.changes) throw new HttpError(409, 'Your password changed. Sign in again before generating recovery keys.')
  return keys
}
export async function resetWithRecoveryKey(env: Env, name: string, key: string, password: string) {
  const invalid = () => new HttpError(400, 'Username or recovery key is invalid. Use an unused key from this installation.')
  const normalized = key.toLowerCase().replace(/[\s-]/g, '')
  if (!/^[a-f0-9]{32}$/.test(normalized)) throw invalid()
  const hash = await digest(normalized)
  const identity = await env.DB.prepare('SELECT r.user_id AS userId FROM recovery_keys r JOIN auth_user u ON u.id = r.user_id WHERE r.hash = ? AND r.claim_id IS NULL AND u.username = ?').bind(hash, name.toLowerCase()).first<{ userId: string }>()
  if (!identity) throw invalid()
  const claim = crypto.randomUUID(), hashedPassword = await hashPassword(password)
  // All writes are conditional on winning this key. Batch makes claim, password
  // replacement, session revocation and invalidation of the whole key set atomic.
  const owner = 'SELECT user_id FROM recovery_keys WHERE hash = ? AND claim_id = ?'
  const result = await env.DB.batch([
    env.DB.prepare("UPDATE recovery_keys SET claim_id = ? WHERE hash = ? AND claim_id IS NULL AND EXISTS (SELECT 1 FROM auth_account WHERE user_id = recovery_keys.user_id AND provider_id = 'credential')").bind(claim, hash),
    env.DB.prepare(`UPDATE auth_account SET password = ?, updated_at = ? WHERE provider_id = 'credential' AND user_id IN (${owner})`).bind(hashedPassword, Date.now(), hash, claim),
    env.DB.prepare(`DELETE FROM auth_session WHERE user_id IN (${owner})`).bind(hash, claim),
    env.DB.prepare(`DELETE FROM sessions WHERE user_id IN (${owner})`).bind(hash, claim),
    env.DB.prepare(`DELETE FROM recovery_keys WHERE user_id IN (${owner})`).bind(hash, claim),
  ])
  if (!result[0]?.meta.changes || !result[1]?.meta.changes) throw invalid()
  const servers = await env.DB.prepare('SELECT workspace_id AS id FROM memberships WHERE user_id = ?').bind(identity.userId).all<{ id: string }>()
  await Promise.all(servers.results.map(row => env.HUBS.getByName(row.id).revokeUser(identity.userId).catch(() => { console.warn(JSON.stringify({ event: 'recovery_live_revoke_failed', workspaceId: row.id })) })))
}
export async function previewInvite(env: Env, token: string) {
  const row = await env.DB.prepare('SELECT i.workspace_id AS workspaceId, w.name, w.initials FROM invitations i JOIN workspaces w ON w.id = i.workspace_id WHERE i.hash = ? AND i.expires_at > ? AND i.uses < i.max_uses').bind(await digest(token), Date.now()).first<{ workspaceId: string; name: string; initials: string }>()
  if (!row) throw new HttpError(410, 'This invitation has expired, reached its limit or been revoked')
  return row
}
export async function acceptInvite(env: Env, userId: string, token: string) {
  const invite = await previewInvite(env, token), hash = await digest(token)
  const result = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO memberships (user_id, workspace_id, role) SELECT ?, i.workspace_id, 'member' FROM invitations i WHERE i.hash = ? AND i.expires_at > ? AND i.uses < i.max_uses AND NOT EXISTS (SELECT 1 FROM workspace_bans b WHERE b.workspace_id = i.workspace_id AND b.user_id = ?)").bind(userId, hash, Date.now(), userId),
    // changes() belongs to the preceding INSERT within this transaction.
    env.DB.prepare('UPDATE invitations SET uses = uses + 1 WHERE hash = ? AND changes() = 1').bind(hash),
    env.DB.prepare('SELECT 1 AS joined FROM memberships WHERE user_id = ? AND workspace_id = ?').bind(userId, invite.workspaceId),
  ])
  if (!result[2]?.results.length) throw new HttpError(403, 'You cannot join this server with this invitation')
  return invite.workspaceId
}

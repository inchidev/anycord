import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import * as tables from '../db/schema'
import { effectivePermissions, permissionDefinitions, permissionKeys, defaultPermissions, everyoneRoleId, isPermissionKey, supportsScope, type PermissionKey } from '../shared/permissions'
import { roleInputSchema, memberRolesInputSchema, overridesInputSchema } from '../shared/contracts'
import { database, requireMembership } from './store'
import { HttpError } from './security'

export async function initializeRoles(env: Pick<Env, 'DB'>, workspaceId: string) {
  const id = everyoneRoleId(workspaceId)
  const exists = await env.DB.prepare('SELECT id FROM roles WHERE id = ?').bind(id).first()
  if (exists) return
  // One transaction initializes defaults. Existing roles never receive new keys implicitly.
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO roles (id, workspace_id, name, color, position) VALUES (?, ?, '@everyone', '#949ba4', 0)").bind(id, workspaceId),
    ...defaultPermissions.map(key => env.DB.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)').bind(id, key)),
  ])
}
export async function serverAccess(env: Env, userId: string, workspaceId: string) {
  const membership = await requireMembership(env, userId, workspaceId), db = database(env)
  const [roles, assignments, grants, overrides] = await Promise.all([
    db.select().from(tables.roles).where(eq(tables.roles.workspaceId, workspaceId)).orderBy(tables.roles.position).all(),
    db.select().from(tables.memberRoles).where(and(eq(tables.memberRoles.workspaceId, workspaceId), eq(tables.memberRoles.userId, userId))).all(),
    db.select({ roleId: tables.rolePermissions.roleId, permission: tables.rolePermissions.permission }).from(tables.rolePermissions).innerJoin(tables.roles, eq(tables.roles.id, tables.rolePermissions.roleId)).where(eq(tables.roles.workspaceId, workspaceId)).all(),
    db.select({ channelId: tables.channelOverrides.channelId, subjectType: tables.channelOverrides.subjectType, subjectId: tables.channelOverrides.subjectId, permission: tables.channelOverrides.permission, effect: tables.channelOverrides.effect }).from(tables.channelOverrides).innerJoin(tables.channels, eq(tables.channels.id, tables.channelOverrides.channelId)).where(eq(tables.channels.workspaceId, workspaceId)).all(),
  ])
  const roleIds = assignments.map(item => item.roleId), everyoneId = everyoneRoleId(workspaceId)
  const owner = membership.role === 'owner'
  const permissions = owner ? [...permissionKeys] : [...new Set(grants.filter(item => item.roleId === everyoneId || roleIds.includes(item.roleId)).map(item => item.permission).filter(isPermissionKey))]
  const highestRolePosition = owner ? 10001 : Math.max(0, ...roles.filter(role => roleIds.includes(role.id)).map(role => role.position))
  return {
    owner, userId, workspaceId, roleIds, permissions, highestRolePosition, overrides,
    roles: roles.map(role => ({ ...role, permissions: grants.filter(item => item.roleId === role.id).map(item => item.permission).filter(isPermissionKey) })),
    channelPermissions(channelId: string) { return owner ? [...permissionKeys] : effectivePermissions(permissions, overrides.filter(item => item.channelId === channelId), everyoneId, roleIds, userId) },
  }
}
export function assertPermission(permissions: readonly string[], key: PermissionKey) {
  if (!permissions.includes(key)) throw new HttpError(403, `Missing permission: ${key}`)
}
export async function requirePermission(env: Env, userId: string, workspaceId: string, key: PermissionKey, channelId?: string) {
  const access = await serverAccess(env, userId, workspaceId)
  const permissions = channelId ? access.channelPermissions(channelId) : access.permissions
  if (channelId) assertPermission(permissions, 'channels.view')
  assertPermission(permissions, key)
  return access
}
export async function canReadChannel(env: Env, userId: string, channelId: string) {
  const channel = await database(env).select().from(tables.channels).where(eq(tables.channels.id, channelId)).get()
  if (!channel) return false
  try { await requirePermission(env, userId, channel.workspaceId, 'messages.read', channelId); return true }
  catch (error) { if (error instanceof HttpError && error.status === 403) return false; throw error }
}
export const permissionMutationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), input: roleInputSchema }),
  z.object({ kind: z.literal('update'), roleId: z.string(), input: roleInputSchema }),
  z.object({ kind: z.literal('delete'), roleId: z.string() }),
  z.object({ kind: z.literal('assign'), userId: z.string(), input: memberRolesInputSchema }),
  z.object({ kind: z.literal('overrides'), channelId: z.string(), input: overridesInputSchema }),
])
export type PermissionMutation = z.infer<typeof permissionMutationSchema>

// Called inside the workspace Hub's serialized access queue, including member removal.
export async function preparePermissionMutation(env: Env, workspaceId: string, actorId: string, raw: PermissionMutation) {
  const action = permissionMutationSchema.parse(raw), actor = await serverAccess(env, actorId, workspaceId), db = env.DB
  const statements: D1PreparedStatement[] = []
  const role = (id: string) => {
    const found = actor.roles.find(item => item.id === id)
    if (!found) throw new HttpError(404, 'Role not found in this server')
    return found
  }
  const manageable = (id: string) => {
    const found = role(id)
    if (!actor.owner && (id === everyoneRoleId(workspaceId) || found.position >= actor.highestRolePosition)) throw new HttpError(403, 'You can only manage roles below your highest role')
    return found
  }
  const mayGrant = (keys: readonly string[], available = actor.permissions) => {
    if (!actor.owner && keys.some(key => !available.includes(key as PermissionKey))) throw new HttpError(403, 'You cannot grant or override permissions you do not hold')
  }
  const mayManageRoleGrants = (id: string) => {
    const current = manageable(id)
    mayGrant(current.permissions)
    if (!actor.owner) for (const item of actor.overrides.filter(item => item.subjectType === 'role' && item.subjectId === id)) {
      const available = actor.channelPermissions(item.channelId)
      assertPermission(available, 'channels.view')
      mayGrant([item.permission], available)
    }
    return current
  }
  let targetId: string
  let result: { id: string; workspaceId: string; name: string; color: string; position: number; permissions: PermissionKey[] } | { ok: true } = { ok: true }
  if (action.kind === 'overrides') {
    const channel = await database(env).select().from(tables.channels).where(and(eq(tables.channels.id, action.channelId), eq(tables.channels.workspaceId, workspaceId))).get()
    if (!channel) throw new HttpError(404, 'Channel not found')
    const effective = actor.channelPermissions(channel.id)
    assertPermission(effective, 'channels.view'); assertPermission(effective, 'channels.permissions')
    const existing = await database(env).select().from(tables.channelOverrides).where(eq(tables.channelOverrides.channelId, channel.id)).all()
    const next = action.input.overrides
    // Unchanged overrides above the actor's authority may be retained, never modified.
    const same = (a: typeof existing[number], b: typeof next[number]) => a.subjectType === b.subjectType && a.subjectId === b.subjectId && a.permission === b.permission && a.effect === b.effect
    const changed = [...existing.filter(a => !next.some(b => same(a, b))), ...next.filter(b => !existing.some(a => same(a, b)))]
    mayGrant(changed.map(item => item.permission), effective)
    for (const item of next) {
      if (!supportsScope(item.permission, 'channel')) throw new HttpError(400, 'This permission cannot be overridden in a channel')
      if (item.subjectType === 'role') role(item.subjectId)
      else await requireMembership(env, item.subjectId, workspaceId)
    }
    for (const item of changed) {
      if (item.subjectType === 'role') { const target = role(item.subjectId); if (!actor.owner && target.position >= actor.highestRolePosition) throw new HttpError(403, 'You can only override lower roles') }
      else {
        const target = await serverAccess(env, item.subjectId, workspaceId)
        if (!actor.owner && (target.owner || target.highestRolePosition >= actor.highestRolePosition)) throw new HttpError(403, 'You cannot override this member’s permissions')
      }
    }
    targetId = channel.id
    statements.push(db.prepare('DELETE FROM channel_overrides WHERE channel_id = ?').bind(channel.id), ...next.map(item => db.prepare('INSERT INTO channel_overrides (channel_id, subject_type, subject_id, permission, effect) VALUES (?, ?, ?, ?, ?)').bind(channel.id, item.subjectType, item.subjectId, item.permission, item.effect)))
  } else {
    assertPermission(actor.permissions, 'roles.manage')
    if (action.kind === 'assign') {
      const target = await serverAccess(env, action.userId, workspaceId)
      if (!actor.owner && (target.owner || target.highestRolePosition >= actor.highestRolePosition)) throw new HttpError(403, 'You can only assign roles to lower members')
      for (const id of action.input.roleIds) {
        if (id === everyoneRoleId(workspaceId)) throw new HttpError(400, '@everyone is implicit')
        role(id)
      }
      const changed = [...target.roleIds.filter(id => !action.input.roleIds.includes(id)), ...action.input.roleIds.filter(id => !target.roleIds.includes(id))]
      for (const id of changed) mayManageRoleGrants(id)
      targetId = target.userId
      statements.push(db.prepare('DELETE FROM member_roles WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, targetId), ...action.input.roleIds.map(id => db.prepare('INSERT INTO member_roles (workspace_id, user_id, role_id) VALUES (?, ?, ?)').bind(workspaceId, targetId, id)))
    } else if (action.kind === 'delete') {
      const current = mayManageRoleGrants(action.roleId)
      if (current.id === everyoneRoleId(workspaceId)) throw new HttpError(400, '@everyone cannot be deleted')
      mayGrant(current.permissions); targetId = current.id
      statements.push(db.prepare("DELETE FROM channel_overrides WHERE subject_type = 'role' AND subject_id = ? AND channel_id IN (SELECT id FROM channels WHERE workspace_id = ?)").bind(targetId, workspaceId), db.prepare('DELETE FROM roles WHERE id = ? AND workspace_id = ?').bind(targetId, workspaceId))
    } else {
      const current = action.kind === 'update' ? mayManageRoleGrants(action.roleId) : undefined
      const input = action.input, everyone = current?.id === everyoneRoleId(workspaceId)
      if (everyone && (input.position !== 0 || input.name !== '@everyone')) throw new HttpError(400, '@everyone must keep its name and position')
      if (!everyone && input.position < 1) throw new HttpError(400, 'Custom roles must be above @everyone')
      if (!actor.owner && input.position >= actor.highestRolePosition) throw new HttpError(403, 'Place this role below your highest role')
      mayGrant([...input.permissions, ...(current?.permissions || [])])
      targetId = current?.id || crypto.randomUUID()
      result = { ...input, id: targetId, workspaceId }
      if (current) statements.push(db.prepare('UPDATE roles SET name = ?, color = ?, position = ? WHERE id = ? AND workspace_id = ?').bind(input.name, input.color, input.position, targetId, workspaceId))
      else statements.push(db.prepare('INSERT INTO roles (id, workspace_id, name, color, position) VALUES (?, ?, ?, ?, ?)').bind(targetId, workspaceId, input.name, input.color, input.position))
      statements.push(db.prepare('DELETE FROM role_permissions WHERE role_id = ?').bind(targetId), ...input.permissions.map(key => db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)').bind(targetId, key)))
    }
  }
  statements.push(db.prepare('INSERT INTO audit_events (id, workspace_id, actor_id, action, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), workspaceId, actorId, `permissions.${action.kind}`, targetId, JSON.stringify(action), Date.now()))
  return { statements, result }
}
export async function permissionsView(env: Env, userId: string, workspaceId: string) {
  const access = await serverAccess(env, userId, workspaceId)
  return { roles: access.roles, permissions: access.permissions, highestRolePosition: access.highestRolePosition, owner: access.owner, definitions: permissionDefinitions }
}
export async function requireLowerMember(env: Env, workspaceId: string, actorId: string, targetId: string, key: 'members.remove' | 'members.ban') {
  const actor = await requirePermission(env, actorId, workspaceId, key), target = await serverAccess(env, targetId, workspaceId)
  if (target.owner || actorId === targetId || (!actor.owner && target.highestRolePosition >= actor.highestRolePosition)) throw new HttpError(403, 'You can only moderate members below your highest role')
}

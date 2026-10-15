export type PermissionScope = 'server' | 'channel'
export type PermissionDefinition = { key: string; label: string; description: string; scopes: readonly PermissionScope[]; default?: boolean }

// Modules extend this registry with an explicit key and a backend enforcement path.
// No wildcards: adding a permission never silently grants it to existing roles.
export const permissionDefinitions = [
  { key: 'server.manage', label: 'Manage server', description: 'Change the server name and icon.', scopes: ['server'] },
  { key: 'roles.manage', label: 'Manage roles', description: 'Manage lower roles and assign permissions you hold.', scopes: ['server'] },
  { key: 'invites.manage', label: 'Manage invitations', description: 'Create and revoke server invitations.', scopes: ['server'] },
  { key: 'members.remove', label: 'Remove members', description: 'Remove members below your highest role.', scopes: ['server'] },
  { key: 'members.ban', label: 'Ban members', description: 'Ban lower members and manage bans.', scopes: ['server'] },
  { key: 'audit.view', label: 'View audit log', description: 'Read role and permission changes.', scopes: ['server'] },
  { key: 'channels.view', label: 'View channel', description: 'Discover this channel and its activity.', scopes: ['server', 'channel'], default: true },
  { key: 'channels.manage', label: 'Manage channels', description: 'Create channels and edit their name and topic.', scopes: ['server', 'channel'] },
  { key: 'channels.permissions', label: 'Manage channel permissions', description: 'Edit channel overrides within your authority.', scopes: ['server', 'channel'] },
  { key: 'messages.read', label: 'Read message history', description: 'Read messages, threads, search results and files.', scopes: ['server', 'channel'], default: true },
  { key: 'messages.send', label: 'Send messages', description: 'Send and edit your messages; send typing activity.', scopes: ['server', 'channel'], default: true },
  { key: 'messages.manage', label: 'Manage messages', description: 'Delete other members’ messages.', scopes: ['server', 'channel'] },
  { key: 'reactions.add', label: 'Add reactions', description: 'React to messages.', scopes: ['server', 'channel'], default: true },
  { key: 'threads.create', label: 'Create threads', description: 'Start a thread from a message.', scopes: ['server', 'channel'], default: true },
  { key: 'attachments.upload', label: 'Upload files', description: 'Upload attachments to messages.', scopes: ['server', 'channel'], default: true },
  { key: 'voice.connect', label: 'Join voice', description: 'Connect to voice huddles.', scopes: ['server', 'channel'], default: true },
  { key: 'voice.speak', label: 'Speak in voice', description: 'Publish microphone audio in a huddle.', scopes: ['server', 'channel'], default: true },
  { key: 'ai.ask', label: 'Ask AI', description: 'Use the installation’s configured AI in this channel.', scopes: ['server', 'channel'], default: true },
] as const satisfies readonly PermissionDefinition[]
export type PermissionKey = (typeof permissionDefinitions)[number]['key']
export const permissionKeys: PermissionKey[] = permissionDefinitions.map(item => item.key)
export const defaultPermissions = permissionDefinitions.filter(item => 'default' in item && item.default).map(item => item.key)
export const isPermissionKey = (key: string): key is PermissionKey => permissionKeys.includes(key as PermissionKey)
export const supportsScope = (key: PermissionKey, scope: PermissionScope) => (permissionDefinitions.find(item => item.key === key)!.scopes as readonly string[]).includes(scope)
export const everyoneRoleId = (workspaceId: string) => `everyone:${workspaceId}`
export type PermissionOverride = { subjectType: 'role' | 'member'; subjectId: string; permission: string; effect: 'allow' | 'deny' }

export function effectivePermissions(base: readonly string[], overrides: readonly PermissionOverride[], everyoneId: string, roleIds: readonly string[], userId: string): PermissionKey[] {
  const result = new Set(base.filter(isPermissionKey))
  const apply = (items: readonly PermissionOverride[]) => {
    for (const item of items) if (isPermissionKey(item.permission) && item.effect === 'deny') result.delete(item.permission)
    for (const item of items) if (isPermissionKey(item.permission) && item.effect === 'allow') result.add(item.permission)
  }
  apply(overrides.filter(item => item.subjectType === 'role' && item.subjectId === everyoneId))
  apply(overrides.filter(item => item.subjectType === 'role' && item.subjectId !== everyoneId && roleIds.includes(item.subjectId)))
  apply(overrides.filter(item => item.subjectType === 'member' && item.subjectId === userId))
  return permissionKeys.filter(key => result.has(key))
}
export function can(subject: { permissions?: readonly string[] } | undefined, key: PermissionKey) { return !!subject?.permissions?.includes(key) }

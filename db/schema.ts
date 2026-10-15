import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text, index, primaryKey, foreignKey, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(), name: text('name').notNull().unique(),
  passwordHash: text('password_hash').notNull(), color: text('color').notNull(),
  role: text('role').notNull().default('member'), createdAt: integer('created_at').notNull(),
})
export const sessions = sqliteTable('sessions', {
  token: text('token').primaryKey(), userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }), expiresAt: integer('expires_at').notNull(),
})
export const workspaces = sqliteTable('workspaces', { id: text('id').primaryKey(), name: text('name').notNull(), initials: text('initials').notNull() })
export const memberships = sqliteTable('memberships', {
  userId: text('user_id').notNull().references(() => users.id), workspaceId: text('workspace_id').notNull().references(() => workspaces.id), role: text('role').notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.workspaceId] })])
export const invitations = sqliteTable('invitations', {
  id: text('id').primaryKey(), hash: text('hash').notNull().unique(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  createdBy: text('created_by').notNull().references(() => users.id), createdAt: integer('created_at').notNull(), expiresAt: integer('expires_at').notNull(),
  maxUses: integer('max_uses').notNull(), uses: integer('uses').notNull().default(0),
}, t => [index('invitations_workspace').on(t.workspaceId)])
export const workspaceBans = sqliteTable('workspace_bans', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id), userId: text('user_id').notNull().references(() => users.id), createdAt: integer('created_at').notNull(),
}, t => [primaryKey({ columns: [t.workspaceId, t.userId] })])
export const recoveryKeys = sqliteTable('recovery_keys', {
  hash: text('hash').primaryKey(), userId: text('user_id').notNull().references(() => users.id), createdAt: integer('created_at').notNull(), claimId: text('claim_id'),
}, t => [index('recovery_keys_user').on(t.userId)])
export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(), topic: text('topic').notNull().default(''), kind: text('kind').notNull().default('text'), position: integer('position').notNull().default(0),
})
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(), channelId: text('channel_id').notNull().references(() => channels.id), authorId: text('author_id').notNull().references(() => users.id),
  text: text('text').notNull(), createdAt: integer('created_at').notNull(), editedAt: integer('edited_at'),
  appId: text('app_id').references((): AnySQLiteColumn => serverApps.id), appRequestId: text('app_request_id'), appRequestHash: text('app_request_hash'),
  replyToId: text('reply_to_id'),
  threadId: text('thread_id').references((): AnySQLiteColumn => threads.id, { onDelete: 'cascade' }),
}, (t) => [uniqueIndex('messages_app_request').on(t.appId, t.appRequestId), index('messages_channel_time').on(t.channelId, t.createdAt), index('messages_thread_time').on(t.threadId, t.createdAt)])
export const threads = sqliteTable('threads', {
  id: text('id').primaryKey(), channelId: text('channel_id').notNull().references(() => channels.id),
  parentMessageId: text('parent_message_id').unique().references((): AnySQLiteColumn => messages.id, { onDelete: 'set null' }),
  name: text('name').notNull(), authorId: text('author_id').notNull().references(() => users.id), createdAt: integer('created_at').notNull(),
}, (t) => [index('threads_channel_time').on(t.channelId, t.createdAt)])
export const reactions = sqliteTable('reactions', {
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }), userId: text('user_id').notNull().references(() => users.id), emoji: text('emoji').notNull(),
}, (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })])
export const settings = sqliteTable('settings', { key: text('key').primaryKey(), value: text('value').notNull() })
export const huddles = sqliteTable('huddles', { channelId: text('channel_id').primaryKey().references(() => channels.id), roomName: text('room_name').notNull(), url: text('url').notNull(), expiresAt: integer('expires_at').notNull() })
export const huddleParticipants = sqliteTable('huddle_participants', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id), channelId: text('channel_id').notNull().references(() => channels.id), meetingId: text('meeting_id').notNull(),
})

// Keep old storage configurations so changing providers does not break existing files.
export const storageConfigs = sqliteTable('storage_configs', { id: text('id').primaryKey(), config: text('config').notNull() })
export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(), channelId: text('channel_id').notNull().references(() => channels.id), ownerId: text('owner_id').notNull().references(() => users.id),
  messageId: text('message_id').references(() => messages.id, { onDelete: 'set null' }), storageId: text('storage_id').notNull().references(() => storageConfigs.id),
  objectKey: text('object_key').notNull(), name: text('name').notNull(), size: integer('size').notNull(), contentType: text('content_type').notNull().default('application/octet-stream'),
  status: text('status').notNull().default('pending'), createdAt: integer('created_at').notNull(),
}, t => [index('attachments_message').on(t.messageId), index('attachments_pending').on(t.createdAt)])
export const liveTickets = sqliteTable('live_tickets', { hash: text('hash').primaryKey(), authorization: text('authorization').notNull(), origin: text('origin').notNull(), workspaceId: text('workspace_id').notNull(), expiresAt: integer('expires_at').notNull() })

export const telegramPreferences = sqliteTable('telegram_preferences', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  preview: integer('preview', { mode: 'boolean' }).notNull().default(false),
  messagingAllowed: integer('messaging_allowed', { mode: 'boolean' }).notNull().default(false),
  mutedChannelIds: text('muted_channel_ids').notNull().default('[]'),
})
export const threadFollowers = sqliteTable('thread_followers', {
  threadId: text('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, t => [primaryKey({ columns: [t.threadId, t.userId] })])
export const telegramOutbox = sqliteTable('telegram_outbox', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  attempts: integer('attempts').notNull().default(0), dueAt: integer('due_at').notNull(),
  status: text('status').notNull().default('pending'),
}, t => [index('telegram_outbox_due').on(t.status, t.dueAt)])

export const installationState = sqliteTable('installation_state', {
  id: integer('id').primaryKey(), installationId: text('installation_id').notNull(),
  maintenanceJob: text('maintenance_job'), outboundDisabled: integer('outbound_disabled').notNull().default(0),
  runnerSeen: integer('runner_seen'), backupHours: integer('backup_hours').notNull().default(0),
  retainBackups: integer('retain_backups').notNull().default(7), lastBackup: integer('last_backup'),
})
export const installationJobs = sqliteTable('installation_jobs', {
  id: text('id').primaryKey(), kind: text('kind').notNull(), status: text('status').notNull(), phase: text('phase').notNull(),
  requestedBy: text('requested_by').notNull(), createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
  targetVersion: text('target_version'), targetCommit: text('target_commit'), targetSchema: text('target_schema'), targetApiVersion: integer('target_api_version'), runnerId: text('runner_id'), claimHash: text('claim_hash'),
  checkpoint: text('checkpoint'), result: text('result'), error: text('error'),
}, t => [uniqueIndex('installation_one_active_job').on(sql`(1)`).where(sql`${t.status} IN ('queued','running')`)])
// Bot profiles outlive uninstall so historical messages retain their identity.
export const serverApps = sqliteTable('server_apps', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  botUserId: text('bot_user_id').notNull().unique().references(() => users.id), name: text('name').notNull(), avatarUrl: text('avatar_url').notNull().default(''),
  kind: text('kind').notNull(), channelIds: text('channel_ids').notNull(), enabled: integer('enabled').notNull(),
  endpointUrl: text('endpoint_url').notNull().default(''), events: text('events').notNull(), commands: text('commands').notNull(),
  tokenHash: text('token_hash').notNull(), signingSecret: text('signing_secret').notNull(),
  createdAt: integer('created_at').notNull(), uninstalledAt: integer('uninstalled_at'),
}, t => [index('server_apps_workspace').on(t.workspaceId)])
export const appAudit = sqliteTable('app_audit', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  appId: text('app_id'), actorId: text('actor_id').notNull(), action: text('action').notNull(), createdAt: integer('created_at').notNull(),
}, t => [index('app_audit_workspace').on(t.workspaceId, t.createdAt)])
export const appInvocations = sqliteTable('app_invocations', {
  id: text('id').primaryKey(), appId: text('app_id').notNull().references(() => serverApps.id), channelId: text('channel_id').notNull().references(() => channels.id),
  userId: text('user_id').notNull().references(() => users.id), requestHash: text('request_hash').notNull(),
  status: text('status').notNull(), messageId: text('message_id'), error: text('error'), createdAt: integer('created_at').notNull(),
})
export const appOutbox = sqliteTable('app_outbox', {
  id: text('id').primaryKey(), appId: text('app_id').notNull().references(() => serverApps.id), channelId: text('channel_id').notNull().references(() => channels.id),
  type: text('type').notNull(), payload: text('payload').notNull(), status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0), dueAt: integer('due_at').notNull(), createdAt: integer('created_at').notNull(),
  lease: text('lease'), lastError: text('last_error'),
}, t => [index('app_outbox_due').on(t.status, t.dueAt)])
// Receipts survive message deletion, so an uncertain retry cannot resurrect a post.
export const appMessageRequests = sqliteTable('app_message_requests', {
  appId: text('app_id').notNull().references(() => serverApps.id), requestId: text('request_id').notNull(),
  requestHash: text('request_hash').notNull(), messageId: text('message_id').notNull(),
}, t => [primaryKey({ columns: [t.appId, t.requestId] })])
// Independent, channel-bound capability URLs for Slack incoming webhook senders.
export const appSlackWebhooks = sqliteTable('app_slack_webhooks', {
  id: text('id').primaryKey(), appId: text('app_id').notNull().references(() => serverApps.id),
  channelId: text('channel_id').notNull().references(() => channels.id), tokenHash: text('token_hash').notNull(), createdAt: integer('created_at').notNull(),
}, t => [uniqueIndex('app_slack_webhooks_channel').on(t.appId, t.channelId)])
export const roles = sqliteTable('roles', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), color: text('color').notNull().default('#949ba4'), position: integer('position').notNull(),
}, t => [uniqueIndex('roles_workspace_id').on(t.workspaceId, t.id), index('roles_workspace_position').on(t.workspaceId, t.position)])
export const rolePermissions = sqliteTable('role_permissions', {
  roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }), permission: text('permission').notNull(),
}, t => [primaryKey({ columns: [t.roleId, t.permission] })])
export const memberRoles = sqliteTable('member_roles', {
  workspaceId: text('workspace_id').notNull(), userId: text('user_id').notNull(), roleId: text('role_id').notNull(),
}, t => [primaryKey({ columns: [t.workspaceId, t.userId, t.roleId] }),
  foreignKey({ columns: [t.workspaceId, t.roleId], foreignColumns: [roles.workspaceId, roles.id] }).onDelete('cascade'),
  foreignKey({ columns: [t.userId, t.workspaceId], foreignColumns: [memberships.userId, memberships.workspaceId] }).onDelete('cascade')])
export const channelOverrides = sqliteTable('channel_overrides', {
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  subjectType: text('subject_type', { enum: ['role', 'member'] }).notNull(), subjectId: text('subject_id').notNull(),
  permission: text('permission').notNull(), effect: text('effect', { enum: ['allow', 'deny'] }).notNull(),
}, t => [primaryKey({ columns: [t.channelId, t.subjectType, t.subjectId, t.permission] })])
export const auditEvents = sqliteTable('audit_events', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').notNull(), action: text('action').notNull(), targetId: text('target_id').notNull(),
  detail: text('detail').notNull(), createdAt: integer('created_at').notNull(),
}, t => [index('audit_workspace_time').on(t.workspaceId, t.createdAt)])

export const installationBackups = sqliteTable('installation_backups', {
  id: text('id').primaryKey(), jobId: text('job_id').notNull(), createdAt: integer('created_at').notNull(),
  manifestHash: text('manifest_hash').notNull(), manifestKey: text('manifest_key').notNull(), destination: text('destination').notNull(),
})

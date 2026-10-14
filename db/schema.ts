import { integer, sqliteTable, text, index, primaryKey, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

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
  replyToId: text('reply_to_id'),
  threadId: text('thread_id').references((): AnySQLiteColumn => threads.id, { onDelete: 'cascade' }),
}, (t) => [index('messages_channel_time').on(t.channelId, t.createdAt), index('messages_thread_time').on(t.threadId, t.createdAt)])
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

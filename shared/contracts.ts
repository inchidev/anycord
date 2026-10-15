import { z } from 'zod'
import { permissionKeys } from './permissions'
export const AUTH_SESSION_CLOSE_CODE = 4001

export const authenticationInputSchema = z.object({
  passwordLogin: z.boolean().default(true), registration: z.boolean().default(true),
  telegramLogin: z.boolean().default(false), miniAppLogin: z.boolean().default(false),
})
export const telegramIntegrationInputSchema = z.object({
  botToken: z.string().trim().max(256).refine(v => !v || /^\d+:[A-Za-z0-9_-]{20,}$/.test(v), 'Enter a valid bot token').optional(),
  clientId: z.string().trim().max(32).regex(/^\d*$/, 'Client ID must contain digits').default(''),
  clientSecret: z.string().trim().max(512).optional(), notifications: z.boolean().default(false),
})
export const telegramIntegrationStatusSchema = z.object({
  botConfigured: z.boolean(), botUsername: z.string(), clientId: z.string(), oidcConfigured: z.boolean(),
  notifications: z.boolean(), origin: z.string(), callbackURL: z.string(), miniAppURL: z.string(), webhookURL: z.string(),
})
export const telegramPreferencesInputSchema = z.object({
  enabled: z.boolean(), preview: z.boolean(), mutedChannelIds: z.array(z.string().min(1).max(128)).max(100),
})
export const telegramAccountStatusSchema = telegramPreferencesInputSchema.extend({
  linked: z.boolean(), canUnlink: z.boolean(), canSetPassword: z.boolean(), botUsername: z.string(),
  notificationsAvailable: z.boolean(), messagingAllowed: z.boolean(), browserLogin: z.boolean(), miniAppLogin: z.boolean(),
})

export const credentialsSchema = z.object({
  name: z.string().trim().min(2, 'Use at least 2 characters for your username.').max(32, 'Use no more than 32 characters.').regex(/^[a-zA-Z0-9_ -]+$/, 'Use letters, numbers, spaces, - or _'),
  setupCode: z.string().max(128).optional(),
  password: z.string().min(10, 'Use at least 10 characters').max(128),
})
export const registrationFormSchema = credentialsSchema.extend({ confirmPassword: z.string() }).refine(v => v.password === v.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] })
export const passwordProofSchema = z.object({ password: z.string().min(1).max(128) })
export const recoveryResetSchema = credentialsSchema.pick({ name: true, password: true }).extend({ recoveryKey: z.string().trim().min(1).max(128) })
export const recoveryFormSchema = recoveryResetSchema.extend({ confirmPassword: z.string() }).refine(v => v.password === v.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] })
export const inviteInputSchema = z.object({ expiresInHours: z.number().int().min(1).max(720).default(168), maxUses: z.number().int().min(1).max(1000).default(25) })
export const inviteTokenSchema = z.object({ token: z.string().regex(/^[a-f0-9]{48}$/) })
export const inviteResultSchema = z.object({ id: z.string(), createdAt: z.number(), expiresAt: z.number(), maxUses: z.number(), uses: z.number() })
export const channelSchema = z.object({
  name: z.string().trim().min(1).max(40).regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers, and hyphens'),
  topic: z.string().trim().max(200).default(''),
  kind: z.enum(['text', 'voice']).default('text'),
})
export const idSchema = z.string().min(1).max(128)
export const messageSchema = z.object({ id: z.uuid(), text: z.string().trim().max(4000), attachmentIds: z.array(z.uuid()).max(4).refine(v => new Set(v).size === v.length).optional(), replyToId: idSchema.optional(), threadId: idSchema.optional() }).refine(v => !!v.text || !!v.attachmentIds?.length, 'Write a message or attach a file')
export const workspaceSchema = z.object({ name: z.string().trim().min(2).max(50) })
export const workspaceUpdateSchema = workspaceSchema.extend({ initials: z.string().trim().min(1).max(4) })
export const channelUpdateSchema = channelSchema.pick({ name: true, topic: true })
export const editMessageSchema = z.object({ text: z.string().trim().min(1).max(4000) })
export const emojiSchema = z.string().min(1).max(32).refine((value) => {
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)]
  return segments.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u.test(value)
}, 'Choose a single emoji')
export const reactionSchema = z.object({ emoji: emojiSchema })
export const threadCreateSchema = z.object({ id: z.uuid(), parentMessageId: idSchema, name: z.string().trim().min(1).max(100) })
export const integrationSchema = z.object({
  realtimeToken: z.string().trim().max(512).optional(),
  realtimeAccountId: z.string().trim().max(64).default(''),
  realtimeAppId: z.string().trim().max(64).default(''),
  realtimeListenerPreset: z.string().trim().max(80).default(''),
  realtimePreset: z.string().trim().min(1).max(80).default('group_call_participant'),
  openrouterKey: z.string().trim().max(512).optional(),
  aiModel: z.string().trim().max(120).default('openai/gpt-4.1-mini'),
})
// IDs are opaque: seeded and migrated IDs are not necessarily UUIDs.
export const userSchema = z.object({ id: idSchema, name: z.string(), color: z.string(), role: z.string(), avatarUrl: z.string().nullable().optional(), telegram: z.boolean().optional() })
export const workspaceResultSchema = z.object({ id: idSchema, name: z.string(), initials: z.string(), role: z.string(), permissions: z.array(z.string()).optional() })
export const channelResultSchema = z.object({ id: idSchema, workspaceId: idSchema, name: z.string(), topic: z.string(), kind: z.enum(['text', 'voice']), permissions: z.array(z.string()).optional() })
export const threadSummarySchema = z.object({ id: idSchema, name: z.string(), messageCount: z.number().int().nonnegative() })
export const threadSchema = threadSummarySchema.extend({ channelId: idSchema, parentMessageId: idSchema.nullable(), authorId: idSchema, createdAt: z.number().int() })
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
export const attachmentInputSchema = z.object({ name: z.string().trim().min(1).max(180).refine(v => !/[\x00-\x1f\x7f]/.test(v)), size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES) })
export const attachmentSchema = attachmentInputSchema.extend({ id: z.uuid(), contentType: z.string() })
export const storageInputSchema = z.object({ driver: z.enum(['r2', 's3']), endpoint: z.string().trim().max(512).default(''), bucket: z.string().trim().max(63).default(''), region: z.string().trim().max(64).default('auto'), accessKeyId: z.string().trim().max(256).optional(), secretAccessKey: z.string().trim().max(512).optional() })
export const storageStatusSchema = z.object({ configured: z.boolean(), nativeAvailable: z.boolean(), driver: z.enum(['r2', 's3']).nullable(), endpoint: z.string(), bucket: z.string(), region: z.string(), maxBytes: z.number(), maxFiles: z.number() })
export const messageResultSchema = z.object({
  id: idSchema, channelId: idSchema, authorId: idSchema, author: z.string(), avatarUrl: z.string().nullable().optional(), color: z.string(), text: z.string(),
  createdAt: z.number().int(), editedAt: z.number().int().nullable(), bot: z.boolean(),
  attachments: z.array(attachmentSchema).default([]),
  reactions: z.array(z.object({ emoji: z.string(), count: z.number().int().positive(), mine: z.boolean() })),
  replyToId: idSchema.nullable(), threadId: idSchema.nullable(),
  reply: z.object({ id: idSchema, author: z.string(), text: z.string() }).nullable(), thread: threadSummarySchema.nullable(),
})
export const memberSchema = userSchema.extend({ workspaceRole: z.string(), roleIds: z.array(idSchema).optional(), highestRolePosition: z.number().optional() })
export const bootstrapSchema = z.object({ user: userSchema, workspaces: z.array(workspaceResultSchema), channels: z.array(channelResultSchema), members: z.array(memberSchema) })
export const integrationsSchema = z.object({
  realtimeConfigured: z.boolean(), realtimeAccountId: z.string(), realtimeAppId: z.string(), realtimePreset: z.string(), realtimeListenerPreset: z.string().default(''),
  aiConfigured: z.boolean(), aiModel: z.string(), email: z.literal('later'),
})
export const searchResultSchema = z.object({ id: idSchema, text: z.string(), channelId: idSchema, channel: z.string(), author: z.string(), createdAt: z.number().int(), threadId: idSchema.nullable() })
export const liveEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), message: messageResultSchema }),
  z.object({ type: z.literal('refresh'), channelId: idSchema.optional() }),
  z.object({ type: z.literal('presence'), users: z.array(idSchema) }),
  z.object({ type: z.literal('typing'), userId: idSchema, name: z.string(), channelId: idSchema, threadId: idSchema.optional() }),
  z.object({ type: z.literal('permissions'), endHuddles: z.boolean().default(false) }),
  z.object({ type: z.literal('ready') }),
])
export const liveClientEventSchema = z.object({ type: z.literal('typing'), channelId: idSchema.max(64), threadId: idSchema.optional() })
export type User = z.infer<typeof userSchema>
export type Workspace = z.infer<typeof workspaceResultSchema>
export type Channel = z.infer<typeof channelResultSchema>
export type Message = z.infer<typeof messageResultSchema>
export type Member = z.infer<typeof memberSchema>
export type Bootstrap = z.infer<typeof bootstrapSchema>
export type Integrations = z.infer<typeof integrationsSchema>
export type LiveEvent = z.infer<typeof liveEventSchema>
export type Thread = z.infer<typeof threadSchema>

export const permissionKeySchema = z.enum(permissionKeys)
export const roleInputSchema = z.object({ name: z.string().trim().min(1).max(64), color: z.string().regex(/^#[a-fA-F0-9]{6}$/), position: z.number().int().min(0).max(10000), permissions: z.array(permissionKeySchema).max(100).refine(v => new Set(v).size === v.length) })
export const roleResultSchema = roleInputSchema.extend({ id: idSchema, workspaceId: idSchema })
export const memberRolesInputSchema = z.object({ roleIds: z.array(idSchema).max(100).refine(v => new Set(v).size === v.length) })
export const overrideSchema = z.object({ subjectType: z.enum(['role', 'member']), subjectId: idSchema, permission: permissionKeySchema, effect: z.enum(['allow', 'deny']) })
export const overridesInputSchema = z.object({ overrides: z.array(overrideSchema).max(500).refine(v => new Set(v.map(i => `${i.subjectType}:${i.subjectId}:${i.permission}`)).size === v.length, 'Duplicate permission override') })
export const permissionsResultSchema = z.object({ roles: z.array(roleResultSchema), permissions: z.array(z.string()), highestRolePosition: z.number(), owner: z.boolean(), definitions: z.array(z.object({ key: z.string(), label: z.string(), description: z.string(), scopes: z.array(z.enum(['server', 'channel'])) })) })
export const auditEventSchema = z.object({ id: idSchema, actorId: idSchema, action: z.string(), targetId: idSchema, detail: z.string(), createdAt: z.number() })

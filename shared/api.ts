import { slackWebhookInputSchema, slackWebhookSchema, slackWebhookCredentialSchema, slackMessageSchema, appPolicySchema, appConfigSchema, appSchema, appCredentialSchema, webhookMessageSchema, commandInvokeSchema, commandResultSchema, commandRegistrySchema, appAuditSchema, appDeliverySchema } from './apps'
import { z } from 'zod'
import { passwordProofSchema, recoveryResetSchema, inviteInputSchema, inviteTokenSchema, inviteResultSchema } from './contracts'
import { authenticationInputSchema, telegramIntegrationInputSchema, telegramIntegrationStatusSchema, telegramPreferencesInputSchema, telegramAccountStatusSchema } from './contracts'
import {
  attachmentInputSchema, attachmentSchema, storageInputSchema, storageStatusSchema, bootstrapSchema, channelSchema, credentialsSchema, editMessageSchema, idSchema, integrationSchema,
  integrationsSchema, messageResultSchema, messageSchema, reactionSchema, searchResultSchema, threadCreateSchema, threadSchema, userSchema, workspaceSchema, workspaceUpdateSchema, workspaceResultSchema, channelUpdateSchema, channelResultSchema,
} from './contracts'

export const API_VERSION = 1
export const engineSchema = z.enum(['celld', 'cloudflare', 'trailbase', 'pocketbase'])
export type Engine = z.infer<typeof engineSchema>
export const apiErrorSchema = z.object({ message: z.string() })
const none = z.undefined()
const noQuery = z.object({})
const ok = z.object({ ok: z.literal(true) })
const created = z.object({ id: idSchema })

function endpoint<const M extends string, const P extends string, B extends z.ZodType, R extends z.ZodType>(
  method: M, path: P, body: B, response: R,
): { method: M; path: P; body: B; response: R; query: typeof noQuery }
function endpoint<const M extends string, const P extends string, B extends z.ZodType, R extends z.ZodType, Q extends z.ZodType>(
  method: M, path: P, body: B, response: R, query: Q,
): { method: M; path: P; body: B; response: R; query: Q }
function endpoint(method: string, path: string, body: z.ZodType, response: z.ZodType, query: z.ZodType = noQuery) {
  return { method, path, body, response, query }
}

// The public wire contract, independent of D1, Durable Objects and backend SDKs.
// Operational migration routes and Better Auth's native endpoints are not public app endpoints.
export const endpoints = {
  slackWebhooks: endpoint('GET', '/api/workspaces/:workspaceId/apps/:appId/slack-webhooks', none, z.array(slackWebhookSchema)),
  slackWebhookCreate: endpoint('POST', '/api/workspaces/:workspaceId/apps/:appId/slack-webhooks', slackWebhookInputSchema, slackWebhookCredentialSchema),
  slackWebhookRotate: endpoint('POST', '/api/workspaces/:workspaceId/apps/:appId/slack-webhooks/:webhookId/rotate', none, slackWebhookCredentialSchema),
  slackWebhookRevoke: endpoint('DELETE', '/api/workspaces/:workspaceId/apps/:appId/slack-webhooks/:webhookId', none, ok),
  slackWebhookPost: endpoint('POST', '/api/compat/slack/services/:workspaceId/:webhookId/:token', slackMessageSchema, z.literal('ok')),
  appPolicy: endpoint('GET', '/api/installation/apps', none, appPolicySchema),
  appPolicyUpdate: endpoint('PUT', '/api/installation/apps', appPolicySchema, appPolicySchema),
  serverApps: endpoint('GET', '/api/workspaces/:workspaceId/apps', none, z.object({ apps: z.array(appSchema), policy: appPolicySchema })),
  appInstall: endpoint('POST', '/api/workspaces/:workspaceId/apps', appConfigSchema, appCredentialSchema),
  appUpdate: endpoint('PUT', '/api/workspaces/:workspaceId/apps/:appId', appConfigSchema, appSchema),
  appRotate: endpoint('POST', '/api/workspaces/:workspaceId/apps/:appId/rotate', none, appCredentialSchema),
  appUninstall: endpoint('DELETE', '/api/workspaces/:workspaceId/apps/:appId', none, ok),
  appAudit: endpoint('GET', '/api/workspaces/:workspaceId/apps-audit', none, appAuditSchema),
  appDeliveries: endpoint('GET', '/api/workspaces/:workspaceId/apps-deliveries', none, appDeliverySchema),
  appPost: endpoint('POST', '/api/apps/:appId/messages', webhookMessageSchema, messageResultSchema),
  commands: endpoint('GET', '/api/channels/:channelId/commands', none, commandRegistrySchema),
  commandInvoke: endpoint('POST', '/api/channels/:channelId/commands', commandInvokeSchema, commandResultSchema),
  commandResult: endpoint('GET', '/api/channels/:channelId/commands/:invocationId', none, commandResultSchema),
  runtime: endpoint('GET', '/api/runtime', none, z.object({ apiVersion: z.literal(API_VERSION), engine: engineSchema, auth: z.literal('better-auth'), realtime: z.literal('websocket'), build: z.object({ version: z.string(), commit: z.string(), apiVersion: z.number().int(), schema: z.string() }).optional() })),
  authStatus: endpoint('GET', '/api/auth/status', none, z.object({ initialized: z.boolean(), setupRequired: z.boolean().default(false), user: userSchema.nullable(), methods: authenticationInputSchema.optional() })),
  authentication: endpoint('GET', '/api/installation/authentication', none, authenticationInputSchema),
  authenticationUpdate: endpoint('PUT', '/api/installation/authentication', authenticationInputSchema, authenticationInputSchema),
  telegramIntegration: endpoint('GET', '/api/integrations/telegram', none, telegramIntegrationStatusSchema),
  telegramIntegrationUpdate: endpoint('PUT', '/api/integrations/telegram', telegramIntegrationInputSchema, telegramIntegrationStatusSchema),
  telegramWebhookSetup: endpoint('POST', '/api/integrations/telegram/webhook', none, ok),
  telegramAccount: endpoint('GET', '/api/account/telegram', none, telegramAccountStatusSchema),
  telegramProfileSync: endpoint('POST', '/api/account/telegram/profile', z.object({ initData: z.string().min(1).max(16_000) }), userSchema),
  telegramPreferences: endpoint('PUT', '/api/account/telegram', telegramPreferencesInputSchema, telegramAccountStatusSchema),
  telegramUnlink: endpoint('DELETE', '/api/account/telegram', none, ok),
  telegramTest: endpoint('POST', '/api/account/telegram/test', none, ok),
  accountPassword: endpoint('POST', '/api/account/password', z.object({ username: credentialsSchema.shape.name, password: credentialsSchema.shape.password }), ok),
  threadFollow: endpoint('GET', '/api/channels/:channelId/threads/:threadId/follow', none, z.object({ following: z.boolean() })),
  threadFollowUpdate: endpoint('PUT', '/api/channels/:channelId/threads/:threadId/follow', z.object({ following: z.boolean() }), z.object({ following: z.boolean() })),
  authRegister: endpoint('POST', '/api/auth/register', credentialsSchema, z.object({ user: userSchema })),
  authLogin: endpoint('POST', '/api/auth/login', credentialsSchema, z.object({ user: userSchema })),
  authLogout: endpoint('POST', '/api/auth/logout', none, z.object({ success: z.literal(true) })),
  recoveryStatus: endpoint('GET', '/api/account/recovery', none, z.object({ count: z.number().int(), generatedAt: z.number().nullable() })),
  recoveryGenerate: endpoint('POST', '/api/account/recovery', passwordProofSchema, z.object({ keys: z.array(z.string()) })),
  recoveryReset: endpoint('POST', '/api/recovery/reset', recoveryResetSchema, ok),
  invitePreview: endpoint('POST', '/api/invitations/preview', inviteTokenSchema, z.object({ name: z.string(), initials: z.string() })),
  inviteAccept: endpoint('POST', '/api/invitations/accept', inviteTokenSchema, z.object({ workspaceId: idSchema })),
  invites: endpoint('GET', '/api/workspaces/:workspaceId/invites', none, z.array(inviteResultSchema)),
  inviteCreate: endpoint('POST', '/api/workspaces/:workspaceId/invites', inviteInputSchema, inviteResultSchema.extend({ token: z.string() })),
  inviteRevoke: endpoint('DELETE', '/api/workspaces/:workspaceId/invites/:inviteId', none, ok),
  memberRemove: endpoint('DELETE', '/api/workspaces/:workspaceId/members/:userId', none, ok),
  memberBan: endpoint('POST', '/api/workspaces/:workspaceId/bans/:userId', none, ok),
  bans: endpoint('GET', '/api/workspaces/:workspaceId/bans', none, z.array(z.object({ id: idSchema, name: z.string(), createdAt: z.number() }))),
  memberUnban: endpoint('DELETE', '/api/workspaces/:workspaceId/bans/:userId', none, ok),
  connectionLogin: endpoint('POST', '/api/connections/login', credentialsSchema, z.object({ token: z.string().min(1), user: userSchema })),
  liveTicket: endpoint('POST', '/api/workspaces/:workspaceId/live-ticket', none, z.object({ ticket: z.string().min(1) })),
  bootstrap: endpoint('GET', '/api/bootstrap', none, bootstrapSchema, z.object({ workspace: idSchema.optional() })),
  workspaceCreate: endpoint('POST', '/api/workspaces', workspaceSchema, created),
  workspaceUpdate: endpoint('PATCH', '/api/workspaces/:workspaceId', workspaceUpdateSchema, workspaceResultSchema),
  channelUpdate: endpoint('PATCH', '/api/channels/:channelId', channelUpdateSchema, channelResultSchema),
  channelCreate: endpoint('POST', '/api/workspaces/:workspaceId/channels', channelSchema, created),
  messages: endpoint('GET', '/api/channels/:channelId/messages', none, z.array(messageResultSchema), z.object({ focus: idSchema.optional(), threadId: idSchema.optional() })),
  messageCreate: endpoint('POST', '/api/channels/:channelId/messages', messageSchema, messageResultSchema),
  messageEdit: endpoint('PATCH', '/api/channels/:channelId/messages/:messageId', editMessageSchema, ok),
  messageDelete: endpoint('DELETE', '/api/channels/:channelId/messages/:messageId', none, ok),
  reactionToggle: endpoint('POST', '/api/channels/:channelId/messages/:messageId', reactionSchema, ok),
  threads: endpoint('GET', '/api/channels/:channelId/threads', none, z.array(threadSchema)),
  threadCreate: endpoint('POST', '/api/channels/:channelId/threads', threadCreateSchema, threadSchema),
  thread: endpoint('GET', '/api/channels/:channelId/threads/:threadId', none, z.object({ thread: threadSchema, parent: messageResultSchema.nullable(), messages: z.array(messageResultSchema) }), z.object({ focus: idSchema.optional() })),
  search: endpoint('GET', '/api/search', none, z.array(searchResultSchema), z.object({ workspace: idSchema.optional(), q: z.string().trim().max(100).default('') })),
  aiAsk: endpoint('POST', '/api/channels/:channelId/ai', none, messageResultSchema),
  huddleJoin: endpoint('POST', '/api/channels/:channelId/huddle', none, z.object({ authToken: z.string().min(1), participantId: idSchema, meetingId: idSchema })),
  huddleLeave: endpoint('DELETE', '/api/channels/:channelId/huddle/:participantId', none, ok),
  integrations: endpoint('GET', '/api/integrations', none, integrationsSchema),
  integrationsUpdate: endpoint('PUT', '/api/integrations', integrationSchema, integrationsSchema),
  integrationsAiTest: endpoint('POST', '/api/integrations/ai/test', none, ok),
  integrationsTest: endpoint('POST', '/api/integrations/test', none, ok.extend({ presets: z.array(z.string()) })),
  storage: endpoint('GET', '/api/storage', none, storageStatusSchema),
  storageUpdate: endpoint('PUT', '/api/storage', storageInputSchema, storageStatusSchema),
  storageTest: endpoint('POST', '/api/storage/test', none, ok),
  attachmentCreate: endpoint('POST', '/api/channels/:channelId/attachments', attachmentInputSchema, created),
  attachmentDownload: endpoint('GET', '/api/attachments/:attachmentId/download', none, z.object({ url: z.string() })),
  attachmentDelete: endpoint('DELETE', '/api/attachments/:attachmentId', none, ok),
  database: endpoint('GET', '/api/database', none, z.object({
    migrations: z.array(z.object({ name: z.string(), appliedAt: z.number().int() })),
    counts: z.object({ messages: z.number().int(), channels: z.number().int(), users: z.number().int() }),
    storage: z.string(), driver: z.string(),
  })),
} as const

export type EndpointName = keyof typeof endpoints
type PathKeys<P extends string> = P extends `${string}:${infer Key}/${infer Rest}` ? Key | PathKeys<Rest> : P extends `${string}:${infer Key}` ? Key : never
export type EndpointParams<K extends EndpointName> = Record<PathKeys<(typeof endpoints)[K]['path']>, string>
export type EndpointInput<K extends EndpointName> =
  ([PathKeys<(typeof endpoints)[K]['path']>] extends [never] ? { params?: never } : { params: EndpointParams<K> }) &
  (undefined extends z.input<(typeof endpoints)[K]['body']> ? { body?: never } : { body: z.input<(typeof endpoints)[K]['body']> }) &
  { query?: z.input<(typeof endpoints)[K]['query']> }
export type EndpointOutput<K extends EndpointName> = z.output<(typeof endpoints)[K]['response']>

function fillPath(path: string, params: Record<string, string> = {}) {
  return path.replace(/:([A-Za-z]+)/g, (_, key: string) => encodeURIComponent(idSchema.parse(params[key])))
}
export function endpointUrl<K extends EndpointName>(name: K, params: Record<string, string>, query?: z.input<(typeof endpoints)[K]['query']>) {
  const endpoint = endpoints[name]
  const parsed = endpoint.query.parse(query || {})
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(parsed)) if (value !== undefined) search.set(key, String(value))
  return fillPath(endpoint.path, params) + (search.size ? `?${search}` : '')
}

function compilePath(path: string) {
  return {
    keys: [...path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1]!),
    pattern: new RegExp(`^${path.replace(/:([A-Za-z]+)/g, '([^/]+)')}$`),
  }
}
function readParams(route: ReturnType<typeof compilePath>, pathname: string) {
  const match = route.pattern.exec(pathname)
  if (!match) return
  const params: Record<string, string> = {}
  for (let i = 0; i < route.keys.length; i++) params[route.keys[i]!] = idSchema.parse(decodeURIComponent(match[i + 1]!))
  return params
}
const routes = Object.entries(endpoints).map(([name, spec]) => ({ name: name as EndpointName, spec, ...compilePath(spec.path) }))
export function matchEndpoint(method: string, pathname: string) {
  for (const route of routes) {
    if (route.spec.method !== method) continue
    const params = readParams(route, pathname)
    if (!params) continue
    return { name: route.name, params, spec: route.spec }
  }
}

const liveRoute = '/api/workspaces/:workspaceId/ws'
const livePattern = compilePath(liveRoute)
export function livePath(workspaceId: string) { return fillPath(liveRoute, { workspaceId }) }
export function matchLivePath(pathname: string) { return readParams(livePattern, pathname)?.workspaceId }

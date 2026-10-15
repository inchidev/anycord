import { z } from 'zod'

export const stableVersion = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
export const buildSchema = z.object({ version: stableVersion, commit: z.string().regex(/^[a-f0-9]{40}$/), apiVersion: z.number().int().positive(), schema: z.string().min(1).max(100) })
export const jobRequestSchema = z.object({ id: z.uuid(), kind: z.enum(['backup', 'update']), version: stableVersion.optional() }).refine(x => x.kind !== 'update' || !!x.version, 'Choose a published version')
export const backupPolicySchema = z.object({ backupHours: z.number().int().min(0).max(8760), retainBackups: z.number().int().min(2).max(365) })
export const jobResultSchema = z.object({ backupId: z.uuid().optional(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), files: z.number().int().nonnegative().optional(), bytes: z.number().int().nonnegative().optional(), version: stableVersion.optional() })
export const jobSchema = z.object({ id: z.uuid(), kind: z.enum(['backup', 'update', 'restore']), status: z.enum(['queued', 'running', 'complete', 'failed']), phase: z.string(), createdAt: z.number(), updatedAt: z.number(), targetVersion: z.string().nullable(), targetCommit: z.string().nullable(), targetSchema: z.string().nullable(), targetApiVersion: z.number().nullable(), checkpoint: z.string().nullable(), result: jobResultSchema.nullable(), error: z.string().nullable() })
export const operationsStatusSchema = z.object({ installationId: z.string(), build: buildSchema, engine: z.enum(['celld', 'cloudflare']), runnerSeen: z.number().nullable(), maintenance: z.boolean(), outboundDisabled: z.boolean(), policy: backupPolicySchema, jobs: z.array(jobSchema) })
export const releaseManifestSchema = buildSchema.extend({ format: z.literal(1), engines: z.array(z.enum(['cloudflare', 'celld'])), upgrade: z.object({ fromSchemas: z.array(z.string()), migrations: z.enum(['none', 'backward-compatible']) }).optional(), artifacts: z.array(z.object({ name: z.string(), engine: z.enum(['cloudflare', 'celld']), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive() })) })
export const releaseSchema = z.object({ version: stableVersion, commit: z.string(), apiVersion: z.number(), schema: z.string(), notes: z.string(), compatible: z.boolean(), url: z.string() })

// Explicit application tables. Sessions, OAuth challenges, live tickets,
// active calls and pending deliveries are intentionally not replayed on restore.
export const backupTables = ['app_migrations', 'users', 'auth_user', 'auth_account', 'workspaces', 'memberships', 'channels', 'roles', 'role_permissions', 'member_roles', 'channel_overrides', 'audit_events', 'server_apps', 'app_slack_webhooks', 'app_audit', 'app_message_requests', 'messages', 'threads', 'reactions', 'settings', 'storage_configs', 'attachments', 'invitations', 'recovery_keys', 'workspace_bans', 'telegram_preferences', 'thread_followers'] as const
export const transientTables = ['sessions', 'auth_session', 'auth_verification', 'live_tickets', 'huddle_participants', 'huddles', 'telegram_outbox', 'app_outbox', 'app_invocations'] as const
export const guardedTables = [...backupTables, 'huddles', 'huddle_participants', 'telegram_outbox', 'app_outbox', 'app_invocations'] as const
export const tableNameSchema = z.enum(backupTables)
export const rowSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()]))
export const backupManifestSchema = z.object({
  format: z.literal(1), id: z.uuid(), installationId: z.string().min(1).max(128), origin: z.url(), engine: z.enum(['cloudflare', 'celld']), build: buildSchema, createdAt: z.number().int(),
  tables: z.array(z.object({ name: tableNameSchema, rows: z.number().int().nonnegative(), columns: z.array(z.string()), path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative() })),
  objects: z.array(z.object({ id: z.uuid(), path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive() })),
  secrets: z.object({ path: z.literal('private/secrets.json'), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive() }),
})
export function compareVersions(a: string, b: string) { const aa = stableVersion.parse(a).split('.').map(Number), bb = stableVersion.parse(b).split('.').map(Number); for (let i = 0; i < 3; i++) { const n = aa[i]! - bb[i]!; if (n) return n } return 0 }

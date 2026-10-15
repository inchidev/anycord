import { backupConfig, backupRequest, boundedBackupBytes, saveBackupStorage } from './backup-storage'
import { cloudUpdateConfig, refreshCloudUpdate, saveCloudUpdates } from './cloud-updates'
import { cloudRecovery } from './native-backups'
import { z } from 'zod'
import { backupTables, transientTables, tableNameSchema, rowSchema, backupPolicySchema, jobRequestSchema, jobResultSchema, compareVersions, buildSchema } from '../shared/operations'
import { HttpError, readBody, equalSecret, digest, encrypt, decrypt } from './security'
import { randomToken } from './access'
import { backupObject, restoreObject } from './storage'
import { publishedRelease } from './releases'
import build from '../shared/build-info.json'

type Engine = 'cloudflare' | 'celld'
type State = { installation_id: string; maintenance_job: string | null; outbound_disabled: number; runner_seen: number | null; backup_hours: number; retain_backups: number; last_backup: number | null }
type Job = { id: string; kind: 'backup' | 'update' | 'restore'; status: string; phase: string; requested_by: string; created_at: number; updated_at: number; target_version: string | null; target_commit: string | null; target_schema: string | null; target_api_version: number | null; runner_id: string | null; claim_hash: string | null; checkpoint: string | null; result: string | null; error: string | null }
const json = (value: unknown) => Response.json(value, { headers: { 'Cache-Control': 'no-store' } })
const restoredAuthentication = (value: string) => JSON.stringify({ ...JSON.parse(value), passwordLogin: true, registration: false, telegramLogin: false, miniAppLogin: false, notifications: false, webhookSecret: '' })
export async function operationState(env: Env) {
  const state = await env.DB.prepare('SELECT * FROM installation_state WHERE id=1').first<State>()
  if (!state) throw new HttpError(503, 'Installation operations require the current database migration')
  return state
}
function publicJob(job: Job) {
  return { id: job.id, kind: job.kind, status: job.status, phase: job.phase, createdAt: job.created_at, updatedAt: job.updated_at, targetVersion: job.target_version, targetCommit: job.target_commit, targetSchema: job.target_schema, targetApiVersion: job.target_api_version, checkpoint: job.checkpoint, result: job.result ? jobResultSchema.parse(JSON.parse(job.result)) : null, error: job.error }
}
export async function operationsStatus(env: Env, engine: Engine) {
  await refreshCloudUpdate(env)
  const state = await operationState(env), jobs = await env.DB.prepare('SELECT * FROM installation_jobs ORDER BY created_at DESC LIMIT 30').all<Job>()
  return { installationId: state.installation_id, build, engine, runnerSeen: state.runner_seen, maintenance: !!state.maintenance_job, outboundDisabled: !!state.outbound_disabled, policy: { backupHours: state.backup_hours, retainBackups: state.retain_backups }, jobs: jobs.results.map(publicJob) }
}
export async function queueOperation(env: Env, engine: Engine, actor: string, raw: unknown) {
  const input = jobRequestSchema.parse(raw), state = await operationState(env)
  const existing = await env.DB.prepare('SELECT * FROM installation_jobs WHERE id=?').bind(input.id).first<Job>()
  if (existing) {
    if (existing.kind !== input.kind || existing.target_version !== (input.version || null)) throw new HttpError(409, 'Operation ID is already used for another request')
    return publicJob(existing)
  }
  if (state.maintenance_job) throw new HttpError(409, 'Finish or recover the maintenance operation first')
  const native = actor !== 'operator' && !!(await backupConfig(env))?.verified && (input.kind === 'backup' || !!(await cloudUpdateConfig(env))?.verified)
  if (!native && actor !== 'operator' && (!state.runner_seen || state.runner_seen < Date.now() - 180_000)) throw new HttpError(409, input.kind === 'backup' ? 'Configure separate S3 backup storage first' : 'Configure S3 backups and a cloud update executor first')
  const target = input.kind === 'update' ? await publishedRelease(engine, input.version) : null
  if (target && (!target.compatible || compareVersions(target.version, build.version) <= 0)) throw new HttpError(409, 'Choose a newer compatible immutable release')
  const now = Date.now()
  try { await env.DB.prepare("INSERT INTO installation_jobs (id,kind,status,phase,requested_by,created_at,updated_at,target_version,target_commit,target_schema,target_api_version,runner_id) VALUES (?,?,'queued','queued',?,?,?,?,?,?,?,?)").bind(input.id, input.kind, actor, now, now, target?.version || null, target?.commit || null, target?.schema || null, target?.apiVersion || null, native ? 'native-s3-queued' : null).run() }
  catch { throw new HttpError(409, 'Another installation operation is active') }
  if (native) {
    const started = await env.HUBS.getByName('_operations').beginBackup(input.id, engine)
    if (!started.ok) throw new HttpError(started.status, started.message)
  }
  return publicJob((await env.DB.prepare('SELECT * FROM installation_jobs WHERE id=?').bind(input.id).first<Job>())!)
}
export async function updateBackupPolicy(env: Env, raw: unknown) {
  const policy = backupPolicySchema.parse(raw)
  await env.DB.prepare('UPDATE installation_state SET backup_hours=?,retain_backups=? WHERE id=1').bind(policy.backupHours, policy.retainBackups).run()
  return policy
}
export async function cancelOperation(env: Env, id: string) {
  const job = await env.DB.prepare('SELECT * FROM installation_jobs WHERE id=?').bind(id).first<Job>()
  if (!job || job.status === 'complete') throw new HttpError(404, 'Active operation not found')
  if (job.status !== 'queued' && job.kind !== 'backup') throw new HttpError(409, 'Use the operator recovery command for an interrupted update or restore')
  await env.DB.batch([
    env.DB.prepare("UPDATE installation_jobs SET status='failed',phase='cancelled',claim_hash=NULL,error='Cancelled by installation owner',updated_at=? WHERE id=? AND status!='complete' AND (status='queued' OR kind='backup')").bind(Date.now(), id),
    env.DB.prepare("UPDATE installation_state SET maintenance_job=NULL WHERE maintenance_job=? AND EXISTS (SELECT 1 FROM installation_jobs WHERE id=? AND phase='cancelled')").bind(id, id),
  ])
  return { ok: true as const }
}
async function claimed(env: Env, id: string, request: Request) {
  const job = await env.DB.prepare('SELECT * FROM installation_jobs WHERE id=?').bind(z.uuid().parse(id)).first<Job>()
  if (!job || job.status !== 'running' || !job.claim_hash || !await equalSecret(await digest(request.headers.get('X-Operation-Key') || ''), job.claim_hash)) throw new HttpError(409, 'Operation claim expired or belongs to another runner')
  return job
}
async function snapshotClaim(env: Env, job: Job) {
  if ((await operationState(env)).maintenance_job !== job.id) throw new HttpError(409, 'The snapshot is no longer frozen; discard this incomplete backup')
}
async function claimedBatch(env: Env, job: Job, statements: D1PreparedStatement[]) {
  await env.DB.batch([
    env.DB.prepare("UPDATE installation_jobs SET requested_by=CASE WHEN status='running' AND claim_hash=? THEN requested_by ELSE NULL END WHERE id=?").bind(job.claim_hash, job.id),
    ...statements,
  ])
}
async function tableColumns(env: Env, table: typeof backupTables[number]) {
  return (await env.DB.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>()).results.map(x => x.name)
}
// The complete batch is transactional. The temporary bypass is never visible to
// another writer. Its NOT NULL fence aborts the whole batch after cancellation.
async function restoreBatch(env: Env, job: Job, statements: D1PreparedStatement[], finish = false) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE installation_state SET installation_id=CASE WHEN maintenance_job=? AND EXISTS (SELECT 1 FROM installation_jobs WHERE id=? AND status='running' AND claim_hash=?) THEN installation_id ELSE NULL END, maintenance_job=NULL WHERE id=1`).bind(job.id, job.id, job.claim_hash),
    env.DB.prepare('PRAGMA defer_foreign_keys=ON'), ...statements,
    env.DB.prepare('UPDATE installation_state SET maintenance_job=? WHERE id=1').bind(finish ? null : job.id),
  ])
}
async function isEmptyDestination(env: Env) {
  const row = await env.DB.prepare(`SELECT
    (SELECT count(*) FROM users WHERE id!='system') +
    (SELECT count(*) FROM workspaces WHERE id!='main') +
    (SELECT count(*) FROM channels WHERE id NOT IN ('general','introductions','build-log','hangout')) +
    (SELECT count(*) FROM messages WHERE id!='welcome') +
    (SELECT count(*) FROM auth_user) + (SELECT count(*) FROM attachments) AS n`).first<{ n: number }>()
  return row?.n === 0
}
export async function operatorRoute(request: Request, env: Env, engine: Engine): Promise<Response> {
  if (!env.MIGRATION_TOKEN || !await equalSecret(request.headers.get('X-Migration-Token') || '', env.MIGRATION_TOKEN)) throw new HttpError(403, 'Installation operator access denied')
  const url = new URL(request.url), path = url.pathname.slice('/api/_operations'.length), method = request.method
  if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) throw new HttpError(403, 'Operator requests cannot cross origins')
  if (path === '/status' && method === 'GET') return json(await operationsStatus(env, engine))
  if (path === '/backup-storage' && method === 'PUT') return json(await saveBackupStorage(env, engine, await readBody(request)))
  if (path === '/cloud-updates' && method === 'PUT') return json(await saveCloudUpdates(env, await readBody(request)))
  if (path === '/enqueue' && method === 'POST') return json(await queueOperation(env, engine, 'operator', await readBody(request)))
  if (path === '/heartbeat' && method === 'POST') { await env.DB.prepare('UPDATE installation_state SET runner_seen=? WHERE id=1').bind(Date.now()).run(); return json({ ok: true }) }
  if (path === '/claim' && method === 'POST') {
    const input = z.object({ runnerId: z.uuid(), resumeId: z.uuid().optional() }).parse(await readBody(request))
    await env.DB.prepare('UPDATE installation_state SET runner_seen=? WHERE id=1').bind(Date.now()).run()
    const state = await operationState(env)
    if (!await backupConfig(env) && !input.resumeId && state.backup_hours && (!state.last_backup || state.last_backup + state.backup_hours * 3600_000 <= Date.now()) && !state.maintenance_job) {
      const active = await env.DB.prepare("SELECT id FROM installation_jobs WHERE status IN ('queued','running')").first()
      if (!active) await queueOperation(env, engine, 'operator', { id: crypto.randomUUID(), kind: 'backup' })
    }
    const candidate = input.resumeId ? await env.DB.prepare("SELECT * FROM installation_jobs WHERE id=? AND status IN ('running','failed')").bind(input.resumeId).first<Job>() : await env.DB.prepare("SELECT * FROM installation_jobs WHERE status='queued' AND (runner_id IS NULL OR runner_id!='native-s3-queued') ORDER BY created_at LIMIT 1").first<Job>()
    if (!candidate) return json({ job: null })
    if (candidate.kind === 'update' && candidate.checkpoint && state.maintenance_job !== candidate.id) throw new HttpError(409, 'The update snapshot is no longer frozen; request a fresh update and recovery point')
    if (input.resumeId && candidate.runner_id && candidate.runner_id !== input.runnerId) throw new HttpError(409, 'Recovery must use the configured runner identity after stopping the old runner')
    const key = randomToken() + randomToken(), hash = await digest(key)
    const job = await env.DB.prepare(`UPDATE installation_jobs SET status='running',runner_id=?,claim_hash=?,updated_at=?,error=NULL WHERE id=? AND status=? RETURNING *`).bind(input.runnerId, hash, Date.now(), candidate.id, candidate.status).first<Job>()
    if (!job) throw new HttpError(409, 'Another runner claimed this operation')
    return json({ job: publicJob(job), key })
  }
  if (path === '/restore' && method === 'POST') {
    const input = z.object({ id: z.uuid(), installationId: z.string(), sourceBuild: buildSchema, backupId: z.uuid(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await readBody(request))
    const state = await operationState(env)
    if (input.installationId !== state.installation_id || input.sourceBuild.schema !== build.schema || input.sourceBuild.apiVersion !== build.apiVersion) throw new HttpError(409, 'Restore destination identity or schema does not match; install the matching schema first')
    if (state.maintenance_job || !await isEmptyDestination(env)) throw new HttpError(409, 'Restore requires an empty, independently provisioned destination')
    const now = Date.now()
    await env.DB.batch([
      env.DB.prepare("INSERT INTO installation_jobs (id,kind,status,phase,requested_by,created_at,updated_at,checkpoint,result) VALUES (?,'restore','queued','restore-data','operator',?,?,?,?)").bind(input.id, now, now, input.backupId, JSON.stringify({ backupId: input.backupId, manifestHash: input.manifestHash })),
      env.DB.prepare('UPDATE installation_state SET maintenance_job=?,outbound_disabled=1 WHERE id=1').bind(input.id),
    ])
    if (!await isEmptyDestination(env)) { await cancelOperation(env, input.id); throw new HttpError(409, 'Destination became non-empty; restore refused') }
    return json({ id: input.id })
  }
  const match = /^\/jobs\/([^/]+)(?:\/(.*))?$/.exec(path)
  if (!match) throw new HttpError(404, 'Operator route not found')
  const job = await claimed(env, match[1]!, request), action = match[2] || ''
  if (action.startsWith('recovery-') && method === 'GET') {
    const recovery = await cloudRecovery(env, job.id)
    if (action === 'recovery-manifest') return new Response(recovery.bytes, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
    if (action === 'recovery-key') return json({ key: recovery.config.recoveryKey })
    if (action === 'recovery-payload') {
      const path = url.searchParams.get('path'), allowed = [...recovery.manifest.tables.flatMap(t => t.parts), ...recovery.manifest.objects, recovery.manifest.secrets].find(p => p.path === path)
      if (!allowed) throw new HttpError(404, 'Recovery payload not found')
      const bytes = await boundedBackupBytes(await backupRequest(recovery.config,`${recovery.base}/${allowed.path}`),allowed.encodedSize)
      return new Response(bytes,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store'}})
    }
    throw new HttpError(404, 'Recovery route not found')
  }

  if (action === 'snapshot' && method === 'POST' && job.kind !== 'restore') {
    const state = await operationState(env)
    if (state.maintenance_job && state.maintenance_job !== job.id) throw new HttpError(409, 'Another snapshot is active')
    await claimedBatch(env, job, [
      env.DB.prepare('UPDATE installation_state SET maintenance_job=? WHERE id=1').bind(job.id),
      env.DB.prepare("UPDATE installation_jobs SET phase='snapshot',updated_at=? WHERE id=?").bind(Date.now(), job.id),
    ])
    return json({ ok: true })
  }
  if (action === 'manifest' && method === 'GET') {
    await snapshotClaim(env, job)
    const tables = []
    for (const name of backupTables) {
      const filter = name === 'attachments' ? " WHERE status='uploaded' AND message_id IS NOT NULL" : ''
      const count = await env.DB.prepare(`SELECT count(*) AS n FROM "${name}"${filter}`).first<{ n: number }>()
      tables.push({ name, rows: count!.n, columns: await tableColumns(env, name) })
    }
    return json({ installationId: (await operationState(env)).installation_id, origin: env.AUTH_BASE_URL, engine, build, createdAt: Date.now(), tables })
  }
  if (action === 'secrets' && method === 'GET') { await snapshotClaim(env, job); return json({ APP_SECRET: env.APP_SECRET, MIGRATION_TOKEN: env.MIGRATION_TOKEN, SETUP_TOKEN: env.SETUP_TOKEN || '' }) }
  const tableMatch = /^tables\/([a-z_]+)$/.exec(action)
  if (tableMatch && method === 'GET') {
    await snapshotClaim(env, job)
    const table = tableNameSchema.parse(tableMatch[1]), cursor = z.coerce.number().int().nonnegative().safe().parse(url.searchParams.get('cursor') || 0)
    const filter = table === 'attachments' ? " AND status='uploaded' AND message_id IS NOT NULL" : ''
    const result = await env.DB.prepare(`SELECT rowid AS __backup_cursor, * FROM "${table}" WHERE rowid>?${filter} ORDER BY rowid LIMIT 50`).bind(cursor).all<Record<string, string | number | null>>()
    const next = result.results.at(-1)?.__backup_cursor || cursor
    return json({ cursor: next, rows: result.results.map(({ __backup_cursor, ...row }) => row) })
  }
  const fileMatch = /^objects\/([a-f0-9-]+)$/.exec(action)
  if (fileMatch && method === 'GET') { await snapshotClaim(env, job); return backupObject(env, z.uuid().parse(fileMatch[1])) }
  if (fileMatch && method === 'PUT' && job.kind === 'restore') { await snapshotClaim(env, job); return json(await restoreObject(env, z.uuid().parse(fileMatch[1]), request)) }
  if (action === 'checkpoint' && method === 'POST' && job.kind !== 'restore') {
    await snapshotClaim(env, job)
    const result = jobResultSchema.required({ backupId: true, manifestHash: true }).parse(await readBody(request))
    const now = Date.now()
    await claimedBatch(env, job, [
      env.DB.prepare('UPDATE installation_jobs SET checkpoint=?,result=?,phase=?,status=?,updated_at=? WHERE id=?').bind(result.backupId, JSON.stringify(result), 'checkpoint', job.kind === 'backup' ? 'complete' : 'running', now, job.id),
      env.DB.prepare('UPDATE installation_state SET maintenance_job=?,last_backup=? WHERE maintenance_job=?').bind(job.kind === 'backup' ? null : job.id, now, job.id),
    ])
    return json({ ok: true })
  }
  if (action === 'progress' && method === 'POST') {
    const input = z.object({ phase: z.enum(['deploying', 'verifying', 'restore-data', 'restore-files']) }).parse(await readBody(request))
    if (job.kind === 'update' && !job.checkpoint) throw new HttpError(409, 'A verified recovery point is required before deployment')
    await claimedBatch(env, job, [env.DB.prepare('UPDATE installation_jobs SET phase=?,updated_at=? WHERE id=?').bind(input.phase, Date.now(), job.id)])
    return json({ ok: true })
  }
  if (action === 'rollback' && method === 'POST' && job.kind === 'update') {
    await snapshotClaim(env, job)
    const input = z.object({ sourceBuild: buildSchema, backupId: z.uuid(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await readBody(request))
    const checkpoint = job.result ? jobResultSchema.parse(JSON.parse(job.result)) : null
    if (job.checkpoint !== input.backupId || checkpoint?.manifestHash !== input.manifestHash) throw new HttpError(409, 'Rollback requires this update’s original verified recovery point')
    if (input.sourceBuild.schema !== build.schema || input.sourceBuild.apiVersion !== build.apiVersion) throw new HttpError(409, 'A code rollback cannot undo schema changes; restore into a separate matching destination')
    await claimedBatch(env, job, [env.DB.prepare("UPDATE installation_jobs SET target_version=?,target_commit=?,target_schema=?,target_api_version=?,phase='rollback',updated_at=? WHERE id=?").bind(input.sourceBuild.version, input.sourceBuild.commit, input.sourceBuild.schema, input.sourceBuild.apiVersion, Date.now(), job.id)])
    return json(publicJob((await env.DB.prepare('SELECT * FROM installation_jobs WHERE id=?').bind(job.id).first<Job>())!))
  }
  if (action === 'restore-reset' && method === 'POST' && job.kind === 'restore') {
    await snapshotClaim(env, job)
    // Retries may clear only the data written by this still-fenced restore job.
    const tables = [...transientTables, ...backupTables].reverse()
    await restoreBatch(env, job, tables.map(table => env.DB.prepare(`DELETE FROM "${table}"`)))
    const storageId = await restoreBatchStorage(env, job)
    return json({ storageId })
  }
  if (action === 'verify-table' && method === 'POST') {
    await snapshotClaim(env, job)
    const input = z.object({ table: tableNameSchema, rows: z.array(rowSchema).max(25), restored: z.boolean().default(false), backupSecret: z.string().min(32).max(256).optional() }).parse(await readBody(request, 1_000_000))
    if (input.restored && (job.kind !== 'restore' || !input.backupSecret)) throw new HttpError(400, 'Restored-record verification requires the restore claim and source key')
    const info = (await env.DB.prepare(`PRAGMA table_info("${input.table}")`).all<{ name: string; pk: number }>()).results
    const keys = info.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name)
    for (const original of input.rows) {
      const row = { ...original }
      if (!keys.length || keys.some(k => row[k] === undefined) || Object.keys(row).some(k => !info.some(c => c.name === k))) throw new HttpError(400, 'Invalid verification record columns')
      if (input.restored && input.table === 'settings' && ['activeStorageId', 'restored_outbound_disabled', 'backupStorage', 'cloudUpdates'].includes(String(row.key))) continue
      const actual = await env.DB.prepare(`SELECT * FROM "${input.table}" WHERE ${keys.map(k => `"${k}"=?`).join(' AND ')}`).bind(...keys.map(k => row[k])).first<Record<string, unknown>>()
      if (actual && input.restored) {
        if (input.table === 'auth_account') for (const k of ['access_token', 'refresh_token', 'id_token']) row[k] = null
        if (input.table === 'settings' && ['authentication', 'openrouterKey', 'realtimeToken'].includes(String(row.key)) && row.value) {
          const plain = await decrypt(String(row.value), input.backupSecret!)
          if (await decrypt(String(actual.value), env.APP_SECRET) !== (row.key === 'authentication' ? restoredAuthentication(plain) : plain)) throw new HttpError(409, 'Restored encrypted setting failed verification')
          row.value = String(actual.value)
        }
        if (input.table === 'server_apps') {
          row.enabled = 0
          if (row.signing_secret) {
            if (await decrypt(String(row.signing_secret), input.backupSecret!) !== await decrypt(String(actual.signing_secret), env.APP_SECRET)) throw new HttpError(409, 'Restored app signing secret failed verification')
            row.signing_secret = String(actual.signing_secret)
          }
        }
        if (input.table === 'storage_configs') {
          if (await decrypt(String(row.config), input.backupSecret!) !== await decrypt(String(actual.config), env.APP_SECRET)) throw new HttpError(409, 'Restored storage credentials failed verification')
          row.config = String(actual.config)
        }
        if (input.table === 'attachments') {
          row.storage_id = (await env.DB.prepare("SELECT value FROM settings WHERE key='activeStorageId'").first<{ value: string }>())?.value || null
          row.object_key = `restored/${(await operationState(env)).installation_id}/${job.id}/${row.id}`
        }
      }
      if (!actual || Object.entries(row).some(([k, v]) => actual[k] !== v)) throw new HttpError(409, `Recovery-point verification failed for ${input.table}`)
    }
    return json({ ok: true })
  }
  if (tableMatch && method === 'POST' && job.kind === 'restore') {
    await snapshotClaim(env, job)
    const table = tableNameSchema.parse(tableMatch[1]), input = z.object({ rows: z.array(rowSchema).max(50), links: z.boolean().default(false), backupSecret: z.string().min(32).max(256).optional() }).parse(await readBody(request, 1_000_000))
    const columns = await tableColumns(env, table), state = await operationState(env), statements: D1PreparedStatement[] = []
    const storage = await env.DB.prepare("SELECT value FROM settings WHERE key='activeStorageId'").first<{ value: string }>()
    for (const original of input.rows) {
      if (JSON.stringify(Object.keys(original).sort()) !== JSON.stringify([...columns].sort())) throw new HttpError(400, 'Backup columns do not match the installed schema')
      const row = { ...original }
      if (input.links) {
        if (table !== 'messages') throw new HttpError(400, 'Only message references use the second restore pass')
        statements.push(env.DB.prepare('UPDATE messages SET reply_to_id=?,thread_id=? WHERE id=?').bind(row.reply_to_id, row.thread_id, row.id)); continue
      }
      if (table === 'messages') { row.reply_to_id = null; row.thread_id = null }
      if (table === 'auth_account') for (const key of ['access_token', 'refresh_token', 'id_token']) row[key] = null
      if (table === 'settings' && ['activeStorageId', 'restored_outbound_disabled', 'backupStorage', 'cloudUpdates'].includes(String(row.key))) continue
      if (table === 'settings' && ['authentication', 'openrouterKey', 'realtimeToken'].includes(String(row.key)) && row.value) {
        if (!input.backupSecret) throw new HttpError(400, 'Backup encryption key is required')
        let value = await decrypt(String(row.value), input.backupSecret)
        if (row.key === 'authentication') value = restoredAuthentication(value)
        row.value = await encrypt(value, env.APP_SECRET)
      }
      if (table === 'server_apps') {
        row.enabled = 0
        if (row.signing_secret) {
          if (!input.backupSecret) throw new HttpError(400, 'Backup encryption key is required')
          row.signing_secret = await encrypt(await decrypt(String(row.signing_secret), input.backupSecret), env.APP_SECRET)
        }
      }
      if (table === 'storage_configs') {
        if (!input.backupSecret) throw new HttpError(400, 'Backup encryption key is required')
        row.config = await encrypt(await decrypt(String(row.config), input.backupSecret), env.APP_SECRET)
      }
      if (table === 'attachments') { if (!storage) throw new HttpError(409, 'Destination storage missing'); row.storage_id = storage.value; row.object_key = `restored/${state.installation_id}/${job.id}/${row.id}` }
      statements.push(env.DB.prepare(`INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).bind(...columns.map(c => row[c])))
    }
    if (statements.length) await restoreBatch(env, job, statements)
    return json({ ok: true })
  }
  if (action === 'finish' && method === 'POST') {
    const input = z.object({ success: z.boolean(), result: jobResultSchema.optional() }).parse(await readBody(request))
    if (input.success && job.kind === 'update' && (job.target_version !== build.version || job.target_commit !== build.commit || job.target_schema !== build.schema || job.target_api_version !== build.apiVersion)) throw new HttpError(409, 'The target release has not passed runtime identity verification')
    if (input.success && job.kind === 'restore') {
      await snapshotClaim(env, job)
      if ((await env.DB.prepare('PRAGMA foreign_key_check').all()).results.length) throw new HttpError(409, 'Restored relationships failed verification')
      await restoreBatch(env, job, [env.DB.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('restored_outbound_disabled','true')"), env.DB.prepare("UPDATE installation_jobs SET status='complete',phase='complete',result=?,updated_at=? WHERE id=?").bind(JSON.stringify(input.result || {}), Date.now(), job.id)], true)
    } else {
      await claimedBatch(env, job, [
        env.DB.prepare('UPDATE installation_jobs SET status=?,phase=?,error=?,updated_at=? WHERE id=?').bind(input.success ? 'complete' : 'failed', input.success ? 'complete' : job.phase, input.success ? null : 'Operation interrupted. Resume with the operator recovery command; see runner logs.', Date.now(), job.id),
        env.DB.prepare("UPDATE installation_state SET maintenance_job=NULL WHERE maintenance_job=? AND (?=1 OR ?='backup')").bind(job.id, Number(input.success), job.kind),
      ])
    }
    return json({ ok: true })
  }
  throw new HttpError(404, 'Operator route not found')
}
export async function migrationWriter(env: Env) {
  const state = await operationState(env)
  if (!state.maintenance_job) return undefined
  const job = await env.DB.prepare("SELECT * FROM installation_jobs WHERE id=? AND kind='update' AND status='running'").bind(state.maintenance_job).first<Job>()
  if (!job) throw new HttpError(409, 'Migrations are blocked by the backup/restore operation')
  return (statements: D1PreparedStatement[]) => restoreBatch(env, job, statements)
}
async function restoreBatchStorage(env: Env, job: Job) {
  // Storage setup writes encrypted config, so it runs in a fenced atomic bypass.
  let config: { driver: 'r2' } | { driver: 's3'; endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string }
  if (env.FILES) config = { driver: 'r2' }
  else if (env.STORAGE_ENDPOINT && env.STORAGE_BUCKET && env.STORAGE_ACCESS_KEY_ID && env.STORAGE_SECRET_ACCESS_KEY) config = { driver: 's3', endpoint: env.STORAGE_ENDPOINT, bucket: env.STORAGE_BUCKET, region: env.STORAGE_REGION || 'auto', accessKeyId: env.STORAGE_ACCESS_KEY_ID, secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY }
  else throw new HttpError(409, 'Configure fresh destination file storage before restore')
  const id = `restore-${job.id}`
  await restoreBatch(env, job, [env.DB.prepare('INSERT INTO storage_configs (id,config) VALUES (?,?)').bind(id, await encrypt(JSON.stringify(config), env.APP_SECRET)), env.DB.prepare("INSERT INTO settings (key,value) VALUES ('activeStorageId',?)").bind(id)])
  return id
}

export async function scheduleNativeBackup(env: Env, engine: Engine) {
  const configured = await backupConfig(env)
  if (!configured?.verified) return
  const state = await operationState(env)
  const active = await env.DB.prepare("SELECT id,kind,status,runner_id FROM installation_jobs WHERE status IN ('queued','running') AND requested_by!='operator' ORDER BY created_at LIMIT 1").first<{id:string;kind:string;status:string;runner_id:string|null}>()
  if (active) { if (active.runner_id === 'native-s3-queued' || active.runner_id === 'native-s3') await env.HUBS.getByName('_operations').beginBackup(active.id,engine); return }
  const latest = await env.DB.prepare("SELECT max(created_at) AS created FROM installation_jobs WHERE kind='backup'").first<{created:number|null}>()
  if (state.maintenance_job || !state.backup_hours || Math.max(state.last_backup || 0, latest?.created || 0) + state.backup_hours * 3600_000 > Date.now()) return
  await queueOperation(env,engine,'scheduled-backup',{id:crypto.randomUUID(),kind:'backup'})
}

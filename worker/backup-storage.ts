import { AwsClient } from 'aws4fetch'
import { backupStorageInputSchema, type BackupStorageConfig } from '../shared/backup-settings'
import { decrypt, encrypt, HttpError } from './security'
import { getSetting, setSetting } from './store'
import { assertSeparateBackupStorage } from './storage'

export async function backupConfig(env: Env): Promise<BackupStorageConfig | null> {
  const value = await getSetting(env, 'backupStorage')
  return value ? JSON.parse(await decrypt(value, env.APP_SECRET)) : null
}
export async function backupStorageStatus(env: Env) {
  const c = await backupConfig(env)
  return { configured: !!c, endpoint: c?.endpoint || '', bucket: c?.bucket || '', region: c?.region || 'auto', verified: c?.verified || false }
}
export async function assertOperationsIdle(env: Env) {
  if (await env.DB.prepare("SELECT 1 FROM installation_jobs WHERE status IN ('queued','running')").first()) throw new HttpError(409, 'Finish or cancel the active operation before changing its configuration')
}
export function backupRequest(config: BackupStorageConfig, key: string, method = 'GET', bytes?: Uint8Array) {
  const client = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region: config.region, service: 's3', retries: 1 })
  return client.fetch(`${config.endpoint}/${encodeURIComponent(config.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(20_000), ...(bytes ? { body: bytes as BodyInit, headers: { 'Content-Type': 'application/octet-stream' } } : {}),
  })
}
export async function boundedBackupBytes(response: Response, max = 8 * 1024 * 1024 + 1024) {
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, 'Backup storage request failed. Check its bucket and credentials.') }
  const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let length = 0
  for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > max) { await reader.cancel(); throw new HttpError(502, 'Backup payload exceeds its verified size limit') }; chunks.push(part.value) }
  const bytes = new Uint8Array(length); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length }; return bytes
}
export async function saveBackupStorage(env: Env, engine: 'cloudflare' | 'celld', raw: unknown) {
  await assertOperationsIdle(env)
  const input = backupStorageInputSchema.parse(raw), url = new URL(input.endpoint)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol) || (engine === 'cloudflare' && url.protocol !== 'https:')) throw new HttpError(400, 'Use a plain HTTPS S3 endpoint; local celld storage also supports HTTP')
  const old = await backupConfig(env), endpoint = input.endpoint.replace(/\/+$/, '')
  const same = old?.endpoint === endpoint && old.bucket === input.bucket
  const accessKeyId = input.accessKeyId || (same ? old?.accessKeyId : ''), secretAccessKey = input.secretAccessKey || (same ? old?.secretAccessKey : '')
  if (!accessKeyId || !secretAccessKey) throw new HttpError(400, 'Separate backup storage credentials are required')
  const recoveryKey = old?.recoveryKey || [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join('')
  const config: BackupStorageConfig = { ...input, endpoint, accessKeyId, secretAccessKey, recoveryKey, verified: false }
  const key = `attachments/anycord-backup-storage-check-${crypto.randomUUID()}`, bytes = crypto.getRandomValues(new Uint8Array(32))
  const put = await backupRequest(config, key, 'PUT', bytes)
  if (!put.ok) { await put.body?.cancel(); throw new HttpError(502, 'Backup storage rejected the connection check') }; await put.body?.cancel()
  try {
    const actual = await boundedBackupBytes(await backupRequest(config, key), bytes.length)
    if (actual.length !== bytes.length || actual.some((v, i) => v !== bytes[i])) throw new HttpError(502, 'Backup storage readback failed')
    // A random probe detects aliases of the same physical attachment bucket too.
    await assertSeparateBackupStorage(env, config, key)
  } finally { const removed = await backupRequest(config, key, 'DELETE'); await removed.body?.cancel(); if (!removed.ok && removed.status !== 404) throw new HttpError(502, 'Backup storage cannot delete its connection-check object') }
  config.verified = true
  await assertOperationsIdle(env)
  await setSetting(env, 'backupStorage', await encrypt(JSON.stringify(config), env.APP_SECRET))
  return { ...await backupStorageStatus(env), ...(!old ? { recoveryKey } : {}) }
}

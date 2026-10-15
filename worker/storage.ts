import { AwsClient } from 'aws4fetch'
import { and, eq, isNull, lt } from 'drizzle-orm'
import { attachments, storageConfigs } from '../db/schema'
import { attachmentInputSchema, MAX_ATTACHMENT_BYTES, storageInputSchema, type User } from '../shared/contracts'
import { database, getSetting, requireChannel, setSetting } from './store'
import { decrypt, digest, encrypt, equalSecret, HttpError, readBody } from './security'

type StorageConfig = { driver: 'r2' } | { driver: 's3'; endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string }
type FileRow = typeof attachments.$inferSelect
const publicFile = (f: FileRow) => ({ id: f.id, name: f.name, size: f.size, contentType: f.contentType })
async function loadConfig(env: Env, id: string): Promise<StorageConfig> {
  const row = await database(env).select().from(storageConfigs).where(eq(storageConfigs.id, id)).get()
  if (!row) throw new HttpError(503, 'File storage is unavailable')
  return JSON.parse(await decrypt(row.config, env.APP_SECRET))
}
async function activeConfig(env: Env) {
  let id = await getSetting(env, 'activeStorageId')
  if (!id && env.FILES) {
    id = 'native-r2'
    await database(env).insert(storageConfigs).values({ id, config: await encrypt(JSON.stringify({ driver: 'r2' }), env.APP_SECRET) }).onConflictDoNothing().run()
  }
  if (!id && env.STORAGE_ENDPOINT && env.STORAGE_BUCKET && env.STORAGE_ACCESS_KEY_ID && env.STORAGE_SECRET_ACCESS_KEY) {
    const config: StorageConfig = { driver: 's3', endpoint: env.STORAGE_ENDPOINT, bucket: env.STORAGE_BUCKET, region: env.STORAGE_REGION || 'auto', accessKeyId: env.STORAGE_ACCESS_KEY_ID, secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY }
    id = `env-${await digest(JSON.stringify(config))}`
    await database(env).insert(storageConfigs).values({ id, config: await encrypt(JSON.stringify(config), env.APP_SECRET) }).onConflictDoNothing().run()
  }
  return id ? { id, config: await loadConfig(env, id) } : null
}
export async function storageStatus(env: Env) {
  const active = await activeConfig(env), config = active?.config
  return { configured: !!active, nativeAvailable: !!env.FILES, driver: config?.driver || null,
    endpoint: config?.driver === 's3' ? config.endpoint : '', bucket: config?.driver === 's3' ? config.bucket : '', region: config?.driver === 's3' ? config.region : 'auto', maxBytes: MAX_ATTACHMENT_BYTES, maxFiles: 4 }
}
export async function updateStorage(env: Env, request: Request) {
  const input = storageInputSchema.parse(await readBody(request))
  let config: StorageConfig
  if (input.driver === 'r2') {
    if (!env.FILES) throw new HttpError(400, 'This deployment has no R2 bucket binding')
    config = { driver: 'r2' }
  } else {
    let url: URL
    try { url = new URL(input.endpoint) } catch { throw new HttpError(400, 'Enter an S3 endpoint URL') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new HttpError(400, 'Use a plain HTTP or HTTPS S3 endpoint')
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) throw new HttpError(400, 'Enter a valid bucket name')
    const previous = await activeConfig(env)
    const old = previous?.config.driver === 's3' ? previous.config : undefined
    // A blank secret preserves credentials only for the same destination.
    const same = old?.endpoint === input.endpoint.replace(/\/$/, '') && old.bucket === input.bucket
    const accessKeyId = input.accessKeyId || (same ? old?.accessKeyId : '')
    const secretAccessKey = input.secretAccessKey || (same ? old?.secretAccessKey : '')
    if (!accessKeyId || !secretAccessKey) throw new HttpError(400, 'Access key and secret are required for a new storage destination')
    config = { driver: 's3', endpoint: input.endpoint.replace(/\/$/, ''), bucket: input.bucket, region: input.region || 'auto', accessKeyId, secretAccessKey }
  }
  const id = crypto.randomUUID()
  await database(env).insert(storageConfigs).values({ id, config: await encrypt(JSON.stringify(config), env.APP_SECRET) }).run()
  await setSetting(env, 'activeStorageId', id)
  return storageStatus(env)
}
function s3Request(config: Extract<StorageConfig, { driver: 's3' }>, key: string, method: string, body?: Uint8Array) {
  const signer = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region: config.region, service: 's3', retries: 1 })
  const url = `${config.endpoint}/${encodeURIComponent(config.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`
  return signer.fetch(url, { method, ...(body ? { body: body as BodyInit, headers: { 'Content-Type': 'application/octet-stream' } } : {}), signal: AbortSignal.timeout(20_000) })
}
async function put(env: Env, config: StorageConfig, key: string, bytes: Uint8Array) {
  if (config.driver === 'r2') { await env.FILES.put(key, bytes); return }
  const result = await s3Request(config, key, 'PUT', bytes)
  if (!result.ok) { await result.body?.cancel(); throw new HttpError(502, 'Storage rejected the upload. Check bucket and credentials.') }
  await result.body?.cancel()
}
async function remove(env: Env, config: StorageConfig, key: string) {
  if (config.driver === 'r2') { await env.FILES.delete(key); return }
  const result = await s3Request(config, key, 'DELETE')
  if (!result.ok && result.status !== 404) { await result.body?.cancel(); throw new HttpError(502, 'Could not remove stored file') }
  await result.body?.cancel()
}
export async function testStorage(env: Env) {
  const active = await activeConfig(env)
  if (!active) throw new HttpError(400, 'Configure file storage first')
  const key = `checks/${crypto.randomUUID()}`
  await put(env, active.config, key, new TextEncoder().encode('Anycord storage check'))
  await remove(env, active.config, key)
  return { ok: true }
}
export async function createAttachment(env: Env, user: User, channelId: string, request: Request) {
  const input = attachmentInputSchema.parse(await readBody(request)), channel = await requireChannel(env, user, channelId)
  if (channel.kind !== 'text') throw new HttpError(400, 'Files belong in a text channel')
  const active = await activeConfig(env)
  if (!active) throw new HttpError(503, 'The installation owner needs to configure file storage')
  const pending = await env.DB.prepare('SELECT COUNT(*) AS n FROM attachments WHERE owner_id = ? AND message_id IS NULL').bind(user.id).first<{ n: number }>()
  if ((pending?.n || 0) >= 32) throw new HttpError(429, 'Too many unfinished attachments. Remove some or try later.')
  const id = crypto.randomUUID()
  await database(env).insert(attachments).values({ ...input, id, channelId, ownerId: user.id, storageId: active.id, objectKey: `attachments/${id}`, createdAt: Date.now() }).run()
  return { id }
}
async function requireAttachment(env: Env, user: User, id: string) {
  const row = await database(env).select().from(attachments).where(eq(attachments.id, id)).get()
  if (!row) throw new HttpError(404, 'Attachment not found')
  await requireChannel(env, user, row.channelId)
  return row
}
// Only sniffed, non-active image formats render inline. Browser-supplied MIME is not trusted.
function sniff(bytes: Uint8Array) {
  const b = [...bytes.slice(0, 16)], text = new TextDecoder().decode(bytes.slice(0, 16))
  if (b.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10') return 'image/png'
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a/.test(text)) return 'image/gif'
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'image/webp'
  return 'application/octet-stream'
}
export async function uploadAttachment(env: Env, user: User, id: string, request: Request) {
  const row = await requireAttachment(env, user, id)
  if (row.ownerId !== user.id || row.messageId || row.status !== 'pending') throw new HttpError(409, 'This attachment cannot be uploaded again')
  if (Number(request.headers.get('Content-Length')) > MAX_ATTACHMENT_BYTES) throw new HttpError(413, 'Files may be up to 8 MB')
  const reader = request.body?.getReader()
  if (!reader) throw new HttpError(400, 'File content is required')
  const chunks: Uint8Array[] = []; let length = 0
  for (;;) {
    const { done, value } = await reader.read(); if (done) break
    length += value.length
    if (length > row.size || length > MAX_ATTACHMENT_BYTES) { await reader.cancel(); throw new HttpError(413, 'File size does not match the upload') }
    chunks.push(value)
  }
  if (length !== row.size) throw new HttpError(400, 'File size does not match the upload')
  const bytes = new Uint8Array(length); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  const claimed = await env.DB.prepare("UPDATE attachments SET status = 'uploading' WHERE id = ? AND status = 'pending' AND message_id IS NULL RETURNING id").bind(id).first()
  if (!claimed) throw new HttpError(409, 'An upload is already in progress')
  try {
    await put(env, await loadConfig(env, row.storageId), row.objectKey, bytes)
    const contentType = sniff(bytes)
    await database(env).update(attachments).set({ status: 'uploaded', contentType }).where(eq(attachments.id, id)).run()
    return publicFile({ ...row, contentType })
  } catch (cause) {
    await database(env).update(attachments).set({ status: 'pending' }).where(eq(attachments.id, id)).run()
    throw cause
  }
}
export async function deleteAttachment(env: Env, user: User, id: string) {
  const row = await requireAttachment(env, user, id)
  if (row.ownerId !== user.id || row.messageId || row.status === 'uploading') throw new HttpError(403, 'Only unfinished uploads can be removed here')
  await remove(env, await loadConfig(env, row.storageId), row.objectKey)
  await database(env).delete(attachments).where(and(eq(attachments.id, id), isNull(attachments.messageId))).run()
  return { ok: true }
}
async function signature(env: Env, id: string, expires: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`attachment:${id}:${expires}`)))].map(v => v.toString(16).padStart(2, '0')).join('')
}
export async function downloadAttachment(env: Env, user: User, id: string) {
  const row = await requireAttachment(env, user, id)
  if (!row.messageId || row.status !== 'uploaded') throw new HttpError(404, 'Attachment not available')
  const expires = String(Date.now() + 5 * 60_000)
  return { url: `/api/attachments/${encodeURIComponent(id)}/content?expires=${expires}&signature=${await signature(env, id, expires)}` }
}
export async function attachmentContent(env: Env, id: string, request: Request) {
  const url = new URL(request.url), expires = url.searchParams.get('expires') || '', sig = url.searchParams.get('signature') || ''
  if (!/^\d{13}$/.test(expires) || Number(expires) < Date.now() || Number(expires) > Date.now() + 300_000 || !await equalSecret(sig, await signature(env, id, expires))) throw new HttpError(403, 'Download link expired')
  const row = await database(env).select().from(attachments).where(eq(attachments.id, id)).get()
  if (!row?.messageId || row.status !== 'uploaded') throw new HttpError(404, 'Attachment not available')
  const config = await loadConfig(env, row.storageId)
  let body: ReadableStream | null
  if (config.driver === 'r2') {
    const object = await env.FILES.get(row.objectKey)
    if (!object) throw new HttpError(404, 'File not found')
    body = object.body
  } else {
    const response = await s3Request(config, row.objectKey, 'GET')
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, 'File storage is unavailable') }
    body = response.body
  }
  return new Response(body, { headers: { 'Content-Type': row.contentType, 'Content-Length': String(row.size), 'Content-Disposition': `${row.contentType.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store' } })
}
export async function cleanupAttachments(env: Env) {
  const rows = await database(env).select().from(attachments).where(and(isNull(attachments.messageId), lt(attachments.createdAt, Date.now() - 86400_000))).limit(100).all()
  for (const row of rows) {
    // Claim prevents a pending message from linking a file while cleanup deletes it.
    const claimed = await env.DB.prepare("UPDATE attachments SET status = 'deleting' WHERE id = ? AND message_id IS NULL RETURNING id").bind(row.id).first()
    if (!claimed) continue
    try { await remove(env, await loadConfig(env, row.storageId), row.objectKey); await database(env).delete(attachments).where(eq(attachments.id, row.id)).run() }
    catch { console.warn(JSON.stringify({ event: 'attachment_cleanup_failed', id: row.id })) }
  }
  await env.DB.prepare('DELETE FROM live_tickets WHERE expires_at < ?').bind(Date.now()).run()
}

// Operator-only callers are authenticated and fenced in installation-operations.
export async function backupObject(env: Env, id: string) {
  const row = await database(env).select().from(attachments).where(eq(attachments.id, id)).get()
  if (!row?.messageId || row.status !== 'uploaded') throw new HttpError(404, 'Committed attachment not found')
  const config = await loadConfig(env, row.storageId)
  if (config.driver === 'r2') {
    const object = await env.FILES.get(row.objectKey)
    if (!object) throw new HttpError(404, 'Attachment object is missing')
    return new Response(object.body, { headers: { 'Content-Length': String(row.size) } })
  }
  const response = await s3Request(config, row.objectKey, 'GET')
  if (!response.ok) throw new HttpError(502, 'Attachment storage read failed')
  return response
}
export async function restoreObject(env: Env, id: string, request: Request) {
  const row = await database(env).select().from(attachments).where(eq(attachments.id, id)).get()
  if (!row) throw new HttpError(404, 'Restore attachment not found')
  const reader = request.body?.getReader()
  if (!reader) throw new HttpError(400, 'Attachment body missing')
  const chunks: Uint8Array[] = []; let size = 0
  while (true) {
    const item = await reader.read(); if (item.done) break
    size += item.value.byteLength
    if (size > row.size || size > MAX_ATTACHMENT_BYTES) { await reader.cancel(); throw new HttpError(413, 'Attachment size mismatch') }
    chunks.push(item.value)
  }
  if (size !== row.size) throw new HttpError(400, 'Attachment size mismatch')
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  await put(env, await loadConfig(env, row.storageId), row.objectKey, bytes)
  return { ok: true as const }
}

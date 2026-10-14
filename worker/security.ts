const encoder = new TextEncoder()
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes)).map((v) => v.toString(16).padStart(2, '0')).join('')
const unhex = (value: string) => new Uint8Array(value.match(/.{2}/g)!.map((v) => parseInt(v, 16)))

export async function digest(value: string) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value))) }
export async function equalSecret(a: string, b: string) {
  const aa = await digest(a), bb = await digest(b)
  let diff = 0
  for (let i = 0; i < aa.length; i++) diff |= aa.charCodeAt(i) ^ bb.charCodeAt(i)
  return diff === 0
}
async function derive(password: string, salt: Uint8Array<ArrayBuffer>) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256))
}
export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `${hex(salt)}:${await derive(password, salt)}`
}
export async function verifyPassword(password: string, stored: string) {
  if (!/^[a-f0-9]{32}:[a-f0-9]{64}$/.test(stored)) return false
  const [salt = '', value = ''] = stored.split(':')
  return equalSecret(await derive(password, unhex(salt)), value)
}
async function encryptionKey(secret: string) {
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(secret)), 'AES-GCM', false, ['encrypt', 'decrypt'])
}
export async function encrypt(value: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(secret), encoder.encode(value))
  return `${hex(iv)}:${hex(data)}`
}
export async function decrypt(value: string, secret: string) {
  const [iv = '', data = ''] = value.split(':')
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(iv) }, await encryptionKey(secret), unhex(data)))
}
export async function readBody(request: Request, maxBytes = 20_000) {
  if (!request.headers.get('Content-Type')?.includes('application/json')) throw new HttpError(415, 'Use application/json')
  const reader = request.body?.getReader()
  if (!reader) throw new HttpError(400, 'Request body required')
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.length
    if (length > maxBytes) { await reader.cancel(); throw new HttpError(413, 'Request is too large') }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown } catch { throw new HttpError(400, 'Invalid JSON') }
}

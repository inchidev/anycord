export async function bytesDigest(bytes: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map(x => x.toString(16).padStart(2, '0')).join('')
}
async function payloadKey(secret: string) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('A 64-character backup recovery key is required')
  const bytes = Uint8Array.from(secret.match(/../g)!, x => parseInt(x, 16))
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}
export async function encodeBackupPayload(bytes: Uint8Array, secret: string, nonce = crypto.getRandomValues(new Uint8Array(12))) {
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await payloadKey(secret), new Uint8Array(bytes)))
  const result = new Uint8Array(13 + cipher.length); result[0] = 1; result.set(nonce, 1); result.set(cipher, 13)
  return result
}
export async function decodeBackupPayload(bytes: Uint8Array, secret: string) {
  if (bytes.length < 29 || bytes[0] !== 1) throw new Error('Invalid encrypted backup payload')
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(1, 13) }, await payloadKey(secret), bytes.slice(13)))
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') { const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().map(k => `${JSON.stringify(k)}:${canonical(object[k])}`).join(',')}}` }
  return JSON.stringify(value)
}
async function manifestKey(secret: string) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('A backup recovery key is required')
  const key = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`Anycord backup manifest v2:${secret}`))
  return crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}
export async function authenticateBackupManifest(manifest: Record<string, unknown>, secret: string) {
  const { authentication, ...value } = manifest
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', await manifestKey(secret), new TextEncoder().encode(canonical(value))))].map(x => x.toString(16).padStart(2, '0')).join('')
}
export async function verifyBackupManifest(manifest: Record<string, unknown>, secret: string) {
  const { authentication, ...value } = manifest
  if (typeof authentication !== 'string' || !/^[a-f0-9]{64}$/.test(authentication)) return false
  const signature = Uint8Array.from(authentication.match(/../g)!, x => parseInt(x, 16))
  return crypto.subtle.verify('HMAC', await manifestKey(secret), signature, new TextEncoder().encode(canonical(value)))
}

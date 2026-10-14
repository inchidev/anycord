import { createApiClient } from '../../shared/client'
import { attachmentSchema } from '../../shared/contracts'
import { getApiTarget, type ApiTarget } from './connection'
import { API_VERSION } from '../../shared/api'
import { ContractError } from '../../shared/client'
const runtimeChecks = new Map<string, { expires: number; check: Promise<void> }>()
async function checkWrite(target: ApiTarget, compatibility = true) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('You’re offline. Reconnect to send. Your draft is kept.')
  if (!compatibility) return // Revoking a session must remain possible during a version mismatch.
  let entry = runtimeChecks.get(target.origin)
  if (!entry || entry.expires < Date.now()) {
    const check = $fetch<{ apiVersion: number }>(target.origin + '/api/runtime', { credentials: 'omit', cache: 'no-store' }).then(runtime => {
      if (runtime.apiVersion !== API_VERSION) throw new ContractError('runtime')
    })
    entry = { expires: Date.now() + 30_000, check }
    runtimeChecks.set(target.origin, entry)
    void check.catch(() => { if (runtimeChecks.get(target.origin)?.check === check) runtimeChecks.delete(target.origin) })
  }
  await entry.check
}
export function apiFor(target: ApiTarget = getApiTarget()) {
  // Capture the destination. An old component's pending mutation cannot jump servers.
  const { origin, token } = target
  return createApiClient(async (url, options) => {
    if (options.method !== 'GET') await checkWrite(target, url !== '/api/auth/logout')
    return $fetch(origin + url, {
    method: options.method, credentials: origin ? 'omit' : 'same-origin',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
  })
}
export const api: ReturnType<typeof apiFor> = (name, ...args) => apiFor()(name, ...args)
export function uploadFor(target: ApiTarget = getApiTarget()) {
  return async (id: string, file: File) => {
    await checkWrite(target)
    return attachmentSchema.parse(await $fetch(`${target.origin}/api/attachments/${encodeURIComponent(id)}/upload`, {
    method: 'PUT', credentials: target.origin ? 'omit' : 'same-origin', body: file,
    headers: { 'Content-Type': 'application/octet-stream', ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}) },
    }))
  }
}

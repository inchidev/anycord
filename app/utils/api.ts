import { createApiClient } from '../../shared/client'
import { attachmentSchema } from '../../shared/contracts'
import { getApiTarget, type ApiTarget } from './connection'
export function apiFor(target: ApiTarget = getApiTarget()) {
  // Capture the destination. An old component's pending mutation cannot jump servers.
  const { origin, token } = target
  return createApiClient((url, options) => $fetch(origin + url, {
    method: options.method, credentials: origin ? 'omit' : 'same-origin',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }))
}
export const api: ReturnType<typeof apiFor> = (name, ...args) => apiFor()(name, ...args)
export function uploadFor(target: ApiTarget = getApiTarget()) {
  return async (id: string, file: File) => attachmentSchema.parse(await $fetch(`${target.origin}/api/attachments/${encodeURIComponent(id)}/upload`, {
    method: 'PUT', credentials: target.origin ? 'omit' : 'same-origin', body: file,
    headers: { 'Content-Type': 'application/octet-stream', ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}) },
  }))
}

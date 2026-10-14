export interface ApiTarget { origin: string; token: string }
let target: ApiTarget = { origin: '', token: '' }
export function getApiTarget(): ApiTarget { return { ...target } }
export function setApiTarget(next: ApiTarget) { target = { ...next } }
export function connectionOrigin(input: string) {
  const url = new URL(input.trim())
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Enter the server origin, without a path or credentials.')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Remote servers need HTTPS. HTTP is supported for localhost.')
  return url.origin
}

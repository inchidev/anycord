export function serverPath(serverId: string, channelId?: string) {
  return `/${encodeURIComponent(serverId)}${channelId ? '/' + encodeURIComponent(channelId) : ''}`
}
export function safeNext(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x1f]/.test(value)) return '/servers'
  const path = value.split(/[?#]/)[0]
  if (['/', '/login'].includes(path || '')) return '/servers'
  return value
}

export const pendingInvitationKey = (origin = '') => `anycord:pending-invitation${origin ? ':' + origin : ''}`

export function telegramInvitationLink(token: string, botUsername: string) {
  if (!/^[a-f0-9]{48}$/.test(token) || !/^[a-z0-9_]+$/i.test(botUsername)) return ''
  return `https://t.me/${botUsername}?startapp=invite_${token}`
}

// Never send a capability from another installation to the currently selected API.
export function invitationToken(value: string, origin: string, botUsername = '') {
  const input = value.trim()
  if (/^[a-f0-9]{48}$/.test(input)) return input
  let url: URL
  try { url = new URL(input, origin) } catch { throw new Error('Paste a complete invitation link or invitation code.') }
  if (url.origin === 'https://t.me' && !url.username && !url.password) {
    if (!botUsername || url.pathname.toLowerCase() !== `/${botUsername.toLowerCase()}`) throw new Error('Open this invitation in Telegram, or paste a web invitation for this installation.')
    const token = /^invite_([a-f0-9]{48})$/.exec(url.searchParams.get('startapp') || '')?.[1]
    if (!token || url.hash || [...url.searchParams.keys()].some(key => key !== 'startapp') || url.searchParams.getAll('startapp').length !== 1) throw new Error('This invitation link is incomplete. Ask the server owner for a new link.')
    return token
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/invite' || url.search) throw new Error('Paste a complete invitation link or invitation code.')
  if (url.origin !== origin) throw new Error(`This invitation belongs to ${url.host}. Switch to that installation before joining; accounts are separate.`)
  const token = new URLSearchParams(url.hash.slice(1)).get('token') || ''
  if (!/^[a-f0-9]{48}$/.test(token)) throw new Error('This invitation link is incomplete. Ask the server owner for a new link.')
  return token
}

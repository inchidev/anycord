import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

export async function checkRoles({ api, connect, owner, base, fetch: requestFetch = globalThis.fetch, voice }) {
  const account = async name => api('/api/auth/register', { method: 'POST', body: { name, password: 'correct-horse-battery' }, expected: 201 })
  const manager = await account('roles_manager'), guest = await account('roles_guest')
  const workspaceId = (await api('/api/workspaces', { cookie: owner.cookie, method: 'POST', body: { name: 'Roles test' }, expected: 201 })).data.id
  const prefix = `/api/workspaces/${workspaceId}`, asOwner = { cookie: owner.cookie }
  const invite = (await api(`${prefix}/invites`, { ...asOwner, method: 'POST', body: {}, expected: 201 })).data
  for (const user of [manager, guest]) await api('/api/invitations/accept', { cookie: user.cookie, method: 'POST', body: { token: invite.token } })
  const roleBody = (name, position, permissions) => ({ name, color: '#5865f2', position, permissions })
  const createRole = async body => (await api(`${prefix}/roles`, { ...asOwner, method: 'POST', body, expected: 201 })).data
  const assign = (user, roleIds, cookie = owner.cookie, expected = 200) => api(`${prefix}/members/${user.data.user.id}/roles`, { cookie, method: 'PUT', body: { roleIds }, expected })
  const managerRole = await createRole(roleBody('Maintainer', 50, ['roles.manage', 'channels.manage', 'channels.permissions', 'members.remove', 'channels.view', 'messages.read', 'messages.send']))
  const reader = await createRole(roleBody('Reader', 10, ['channels.view', 'messages.read']))
  const developer = await createRole(roleBody('Developer', 20, ['messages.send']))
  await assign(manager, [managerRole.id]); await assign(guest, [reader.id, developer.id])
  const access = (await api(`${prefix}/permissions`, { cookie: guest.cookie })).data
  assert.equal(access.owner, false); assert.equal(access.highestRolePosition, 20)
  assert(access.definitions.some(item => item.key === 'roles.manage'))
  await api(`${prefix}/roles`, { cookie: guest.cookie, method: 'POST', body: roleBody('Escalate', 90, ['roles.manage']), expected: 403 })
  await api(`${prefix}/roles`, { ...asOwner, method: 'POST', body: roleBody('Unknown', 1, ['arbitrary.execute']), expected: 400 })
  await api(`${prefix}/roles`, { cookie: manager.cookie, method: 'POST', body: roleBody('Above', 51, []), expected: 403 })
  await api(`${prefix}/roles`, { cookie: manager.cookie, method: 'POST', body: roleBody('Forbidden', 1, ['members.ban']), expected: 403 })
  const child = (await api(`${prefix}/roles`, { cookie: manager.cookie, method: 'POST', body: roleBody('Helper', 1, ['messages.send']), expected: 201 })).data
  await assign(manager, [managerRole.id, child.id], manager.cookie, 403)
  await api('/api/integrations', { cookie: manager.cookie, method: 'PUT', body: {}, expected: 403 })
  await api(`${prefix}/members/${owner.data.user.id}`, { cookie: manager.cookie, method: 'DELETE', expected: 403 })
  await api(`${prefix}/roles/${managerRole.id}`, { cookie: manager.cookie, method: 'PUT', body: roleBody('Peer', 50, []), expected: 403 })
  const channelId = (await api(`${prefix}/channels`, { cookie: manager.cookie, method: 'POST', body: { name: 'private-project' }, expected: 201 })).data.id
  const channelPath = `/api/channels/${channelId}`, everyone = `everyone:${workspaceId}`
  const override = (subjectId, permission, effect, subjectType = 'role') => ({ subjectId, permission, effect, subjectType })
  const privateOverrides = [override(everyone, 'channels.view', 'deny'), override(reader.id, 'channels.view', 'allow'), override(managerRole.id, 'channels.view', 'allow')]
  const setOverrides = (overrides, cookie = owner.cookie, expected = 200) => api(`${channelPath}/permissions`, { cookie, method: 'PUT', body: { overrides }, expected })
  await setOverrides(privateOverrides)
  await setOverrides([...privateOverrides, override(reader.id, 'messages.manage', 'allow')])
  await assign(guest, [developer.id])
  await assign(guest, [developer.id, reader.id], manager.cookie, 403)
  await api(`${prefix}/roles/${reader.id}`, { cookie: manager.cookie, method: 'DELETE', expected: 403 })
  await setOverrides(privateOverrides)
  await assign(guest, [reader.id, developer.id])
  const guestLive = await connect(guest.cookie, workspaceId), ownerLive = await connect(owner.cookie, workspaceId)
  const message = { id: crypto.randomUUID(), text: 'private-needle' }
  await api(`${channelPath}/messages`, { ...asOwner, method: 'POST', body: message, expected: 201 })
  await guestLive.until(event => event.type === 'message' && event.message.id === message.id)
  assert((await api(`/api/search?workspace=${workspaceId}&q=private-needle`, { cookie: guest.cookie })).data.some(item => item.id === message.id))
  // Role allows beat combined role denies; a member override then wins.
  await setOverrides([...privateOverrides, override(developer.id, 'channels.view', 'deny')])
  await api(`${channelPath}/messages`, { cookie: guest.cookie })
  await setOverrides([...privateOverrides, override(guest.data.user.id, 'channels.view', 'deny', 'member')])
  await api(`${channelPath}/messages`, { cookie: guest.cookie, expected: 403 })
  await setOverrides(privateOverrides)
  const thread = (await api(`${channelPath}/threads`, { ...asOwner, method: 'POST', body: { id: crypto.randomUUID(), parentMessageId: message.id, name: 'Private thread' }, expected: 201 })).data
  // Obtain a signed download while authorized, then revoke and reuse the same grant.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4GkAAAAASUVORK5CYII=', 'base64')
  const file = (await api(`${channelPath}/attachments`, { ...asOwner, method: 'POST', body: { name: 'private.png', size: png.length }, expected: 201 })).data
  const upload = await requestFetch(`${base}/api/attachments/${file.id}/upload`, { method: 'PUT', headers: { Cookie: owner.cookie }, body: png })
  assert.equal(upload.status, 200, await upload.text())
  await api(`${channelPath}/messages`, { ...asOwner, method: 'POST', body: { id: crypto.randomUUID(), text: 'private file', attachmentIds: [file.id] }, expected: 201 })
  const grant = (await api(`/api/attachments/${file.id}/download`, { cookie: guest.cookie })).data.url
  assert.equal((await requestFetch(base + grant)).status, 200)
  await assign(guest, [developer.id])
  await guestLive.until(event => event.type === 'permissions')
  const bootstrap = (await api(`/api/bootstrap?workspace=${workspaceId}`, { cookie: guest.cookie })).data
  assert(!bootstrap.channels.some(item => item.id === channelId))
  await api(`${channelPath}/messages`, { cookie: guest.cookie, expected: 403 })
  await api(`${channelPath}/threads/${thread.id}`, { cookie: guest.cookie, expected: 403 })
  assert.deepEqual((await api(`/api/search?workspace=${workspaceId}&q=private-needle`, { cookie: guest.cookie })).data, [])
  await api(`/api/attachments/${file.id}/download`, { cookie: guest.cookie, expected: 403 })
  assert.equal((await requestFetch(base + grant)).status, 403, 'Existing signed links must respect access revocation')
  const hidden = { id: crypto.randomUUID(), text: 'must not leak after revocation' }
  await api(`${channelPath}/messages`, { ...asOwner, method: 'POST', body: hidden, expected: 201 })
  await ownerLive.until(event => event.type === 'message' && event.message.id === hidden.id)
  ownerLive.ws.send(JSON.stringify({ type: 'typing', channelId }))
  await delay(150)
  assert(!guestLive.events.some(event => event.type === 'message' && event.message.id === hidden.id))
  assert(!guestLive.events.some(event => event.type === 'typing' && event.channelId === channelId))
  await assign(guest, [reader.id, developer.id])
  await setOverrides([...privateOverrides, override(guest.data.user.id, 'messages.send', 'deny', 'member'), override(guest.data.user.id, 'attachments.upload', 'deny', 'member'), override(guest.data.user.id, 'voice.connect', 'deny', 'member'), override(guest.data.user.id, 'reactions.add', 'deny', 'member')])
  await api(`${channelPath}/messages`, { cookie: guest.cookie, method: 'POST', body: { id: crypto.randomUUID(), text: 'denied' }, expected: 403 })
  await api(`${channelPath}/attachments`, { cookie: guest.cookie, method: 'POST', body: { name: 'no.png', size: 1 }, expected: 403 })
  await api(`${channelPath}/huddle`, { cookie: guest.cookie, method: 'POST', expected: 403 })
  await api(`${channelPath}/messages/${message.id}`, { cookie: guest.cookie, method: 'POST', body: { emoji: '👍' }, expected: 403 })
  if (voice) {
    const listenerOverrides = [...privateOverrides, override(guest.data.user.id, 'voice.speak', 'deny', 'member')]
    await setOverrides(listenerOverrides)
    await api(`${channelPath}/huddle`, { cookie: guest.cookie, method: 'POST', expected: 409 })
    const settings = (await api('/api/integrations', asOwner)).data
    await api('/api/integrations', { ...asOwner, method: 'PUT', body: { ...settings, realtimeListenerPreset: 'listener' } })
    if(voice.listenerMedia){
      voice.listenerMedia('ALLOWED');await api(`${channelPath}/huddle`, { cookie: guest.cookie, method: 'POST', expected:409 })
      voice.listenerMedia('CAN_REQUEST');await api(`${channelPath}/huddle`, { cookie: guest.cookie, method: 'POST', expected:409 })
      voice.listenerMedia('NOT_ALLOWED')
    }
    await api(`${channelPath}/huddle`, { cookie: guest.cookie, method: 'POST' })
    assert.equal(voice.calls.findLast(call => call.method === 'POST' && call.url.endsWith('/participants')).body.preset_name, 'listener')
    voice.rejectRemoval(true)
    await setOverrides([], owner.cookie, 502)
    assert.deepEqual((await api(`${channelPath}/permissions`, asOwner)).data.overrides.map(item => [item.subjectType, item.subjectId, item.permission, item.effect]).sort(), listenerOverrides.map(item => [item.subjectType, item.subjectId, item.permission, item.effect]).sort(), 'Failed provider revocation must leave policy unchanged')
    voice.rejectRemoval(false)
    const deletions = voice.calls.filter(call => call.method === 'DELETE').length
    await setOverrides([...privateOverrides, override(guest.data.user.id, 'voice.connect', 'deny', 'member')])
    assert.equal(voice.calls.filter(call => call.method === 'DELETE').length, deletions + 1)
    await api(`${channelPath}/huddle`, { cookie: guest.cookie, method: 'POST', expected: 403 })
  }
  await setOverrides([...privateOverrides, override(everyone, 'server.manage', 'allow')], owner.cookie, 400)
  await api(`/api/workspaces/main/roles/${reader.id}`, { ...asOwner, method: 'DELETE', expected: 404 })
  await api(`/api/workspaces/main/members/${guest.data.user.id}/roles`, { ...asOwner, method: 'PUT', body: { roleIds: [reader.id] }, expected: 404 })
  const everyoneRole = (await api(`${prefix}/permissions`, asOwner)).data.roles.find(item => item.id === everyone)
  await api(`${prefix}/roles/${everyone}`, { ...asOwner, method: 'DELETE', expected: 400 })
  await api(`${prefix}/roles/${everyone}`, { ...asOwner, method: 'PUT', body: { ...everyoneRole, name: 'rename everyone' }, expected: 400 })
  await api(`${prefix}/audit`, { cookie: guest.cookie, expected: 403 })
  const audit = (await api(`${prefix}/audit`, asOwner)).data
  assert(audit.some(item => item.action === 'permissions.assign' && item.targetId === guest.data.user.id))
  await api(`${prefix}/roles/${reader.id}`, { ...asOwner, method: 'DELETE' })
  const remaining = (await api(`/api/bootstrap?workspace=${workspaceId}`, { cookie: guest.cookie })).data
  assert(!remaining.members.find(item => item.id === guest.data.user.id).roleIds.includes(reader.id))
  assert(!remaining.channels.some(item => item.id === channelId))
  guestLive.ws.close(); ownerLive.ws.close()
  console.log('PASS: custom/multiple roles, hierarchy, unknown permissions, delegated management, owner isolation, channel precedence, private search/thread/file/realtime isolation, signed-link revocation, action scopes and audit.')
}

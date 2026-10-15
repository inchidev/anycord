import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { API_VERSION, endpoints, matchEndpoint, endpointUrl, livePath, matchLivePath, engineSchema, liveEventSchema, liveClientEventSchema, createApiClient, ContractError, emojiGroups, emojiSchema, messageBlocks, quoteMessage, draftStoreKey, prepareAttempt } =
  await import(pathToFileURL(resolve(existsSync('contracts.mjs') ? 'contracts.mjs' : 'runtime/contracts.mjs')))

assert.equal(API_VERSION, 1)
for (const engine of ['celld', 'cloudflare', 'trailbase', 'pocketbase']) assert.equal(engineSchema.parse(engine), engine)
assert.equal(engineSchema.safeParse('unknown').success, false)

// Reserved path characters must stay within one parameter, rather than change routes/queries.
const url = endpointUrl('messages', { channelId: 'channel/a b' }, { focus: 'old?message' })
assert.equal(url, '/api/channels/channel%2Fa%20b/messages?focus=old%3Fmessage')
const match = matchEndpoint('GET', new URL(url, 'http://localhost').pathname)
assert.equal(match.name, 'messages'); assert.equal(match.params.channelId, 'channel/a b')
assert.equal(livePath('server/a b'), '/api/workspaces/server%2Fa%20b/ws')
assert.equal(matchLivePath('/api/workspaces/server%2Fa%20b/ws'), 'server/a b')
assert.equal(matchLivePath('/api/workspaces/main/ws/extra'), undefined)
assert.equal(matchEndpoint('DELETE', '/api/channels/general/ai'), undefined)
assert.equal(matchEndpoint('POST', '/api/channels/general/ai/extra'), undefined)
assert.equal(matchEndpoint('POST', '/api/auth/sign-up/email'), undefined)

let calls = []
const client = createApiClient(async (path, options) => {
  calls.push({ path, ...options })
  return { user: { id: 'alice', name: 'alice', color: '#5865f2', role: 'member' } }
})
await assert.rejects(() => client('authRegister', { body: { name: 'alice', password: 'short' } }))
assert.equal(calls.length, 0, 'Invalid inputs must not reach the transport')
const login = await client('authLogin', { body: { name: 'ALICE', password: 'correct-horse-battery', role: 'owner' } })
assert.equal(login.user.role, 'member')
assert.deepEqual(calls[0], { path: '/api/auth/login', method: 'POST', body: { name: 'ALICE', password: 'correct-horse-battery' } })
await assert.rejects(() => createApiClient(async () => ({ secret: 'must-not-appear-in-error' }))('authStatus'), (error) => {
  assert(error instanceof ContractError); assert.equal(error.endpoint, 'authStatus')
  assert(!JSON.stringify(error).includes('must-not-appear')); assert(!error.message.includes('must-not-appear'))
  return true
})

assert.equal(liveEventSchema.safeParse({ type: 'presence', users: ['alice', 'bob'] }).success, true)
assert.equal(liveEventSchema.safeParse({ type: 'presence', users: 'alice' }).success, false)
assert.equal(liveEventSchema.safeParse({ type: 'unknown' }).success, false)
assert.deepEqual(liveClientEventSchema.parse({ type: 'typing', channelId: 'general', userId: 'spoofed' }), { type: 'typing', channelId: 'general' })
assert.equal(liveClientEventSchema.safeParse({ type: 'message', channelId: 'general' }).success, false)
assert.equal(endpoints.messages.response.safeParse([{ id: 'missing-fields' }]).success, false)
for (const group of emojiGroups) for (const [emoji] of group.items) assert.equal(emojiSchema.parse(emoji), emoji)
for (const emoji of ['👨‍👩‍👧‍👦', '👍🏽', '🇻🇳', '1️⃣']) assert.equal(emojiSchema.parse(emoji), emoji)
for (const value of ['hello', '😀😀', '<script>', '👍x']) assert.equal(emojiSchema.safeParse(value).success, false)
assert.deepEqual(messageBlocks('> alice:\n> quoted text\n\nA reply <script>'), [{ quote: true, text: 'alice:\nquoted text' }, { quote: false, text: '\nA reply <script>' }])
assert.equal(quoteMessage('alice', 'one\ntwo'), '> alice:\n> one\n> two\n\n')
assert.notEqual(draftStoreKey('alice'), draftStoreKey('bob'))
const attempt = prepareAttempt(undefined, { text: 'An uncertain write', channelId: 'general', replyToId: 'original' }, () => 'stable-retry-id')
const restored = JSON.parse(JSON.stringify(attempt))
assert.equal(prepareAttempt(restored, { text: 'An uncertain write', channelId: 'general', replyToId: 'original' }, () => 'must-not-rotate').id, 'stable-retry-id')
assert.equal(prepareAttempt(restored, { text: 'Changed draft', channelId: 'general', replyToId: 'original' }, () => 'new-id').id, 'new-id')
console.log('PASS: engine names, encoded paths, method/route isolation, input validation, incompatible-response handling, and realtime schemas.')

assert.equal(matchEndpoint('PATCH', '/api/workspaces/main').name, 'workspaceUpdate')
assert.equal(matchEndpoint('PATCH', '/api/channels/general').name, 'channelUpdate')
assert.equal(endpoints.workspaceUpdate.body.safeParse({ name: 'Server', initials: 'TOOLONG' }).success, false)
assert.deepEqual(endpoints.channelUpdate.body.parse({ name: 'general', topic: 'Topic', kind: 'voice' }), { name: 'general', topic: 'Topic' })

const { parseSlashCommand, CommandInputError } = await import(pathToFileURL(resolve('runtime/contracts.mjs')))
const commands = [{ appId: 'aabb', appName: 'Echo', name: 'echo', description: 'Echo', arguments: [{ name: 'text', type: 'string', required: true }, { name: 'count', type: 'integer', required: true }, { name: 'enabled', type: 'boolean', required: false }] }]
assert.deepEqual(parseSlashCommand('/echo "hello world" 2 true', commands), { appId: 'aabb', name: 'echo', arguments: { text: 'hello world', count: 2, enabled: true } })
for (const text of ['/echo', '/echo text nope', '/echo text 2 yes', '/echo "unclosed 2', '/echo text 2 true extra', '/unknown']) assert.throws(() => parseSlashCommand(text, commands), CommandInputError)
const ambiguous = [...commands, { ...commands[0], appId: 'bbcc' }]
assert.throws(() => parseSlashCommand('/echo text 2', ambiguous), /Several apps/)
// App IDs in production are UUIDs; encoded IDs are not accepted in slash syntax.
assert.equal(parseSlashCommand('/echo@bbcc text 2', ambiguous).appId, 'bbcc')
console.log('PASS: slash command quoting, typed positional arguments, missing/extra arguments and app disambiguation.')

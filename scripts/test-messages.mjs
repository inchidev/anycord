import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Mount the actual Vue composables with Vue's in-memory renderer. No browser or DOM.
const folder = await mkdtemp(join(tmpdir(), 'anycord-messages-'))
let mounted
try {
  const output = join(folder, 'messages.mjs')
  await build({ stdin: { contents: `
    export * from './app/data/messages'
    export * from './app/composables/useConversationMessages'
    export { createRenderer, ref, nextTick } from 'vue'
    export { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
  `, resolveDir: process.cwd(), loader: 'ts' }, outfile: output, bundle: true, format: 'esm', platform: 'node' })
  const { createRenderer, ref, nextTick, QueryClient, VueQueryPlugin, useChannelMessages, useThreadMessages, receiveMessage, channelMessageOptions } = await import(pathToFileURL(output))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000, gcTime: Infinity } } })
  const renderer = createRenderer({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert: (node, parent) => { node.parent = parent }, remove: () => {},
    parentNode: (node) => node.parent, nextSibling: () => null,
    setText: () => {}, setElementText: () => {}, patchProp: () => {},
  })
  const scope = ref({ userId: 'alice', workspaceId: 'main', channelId: 'general' })
  const message = (id, extra = {}) => ({ id, channelId: 'general', authorId: 'alice', author: 'Alice', color: '#5865f2', text: id, createdAt: Number(id.replace(/\D/g, '')) || 1, editedAt: null, bot: false, reactions: [], replyToId: null, threadId: null, reply: null, thread: null, ...extra })
  let rows = [message('m1')], fail = false, hold
  let calls = 0, state
  globalThis.$fetch = async (url) => {
    calls++
    if (fail) throw new Error('Temporary failure')
    if (hold) { const pending = hold; hold = undefined; return pending.promise }
    if (url.includes('/threads/')) return { thread: { id: 't1', channelId: 'general', name: 'Thread', messageCount: rows.length, parentMessageId: 'parent', authorId: 'alice', createdAt: 1 }, parent: message('parent'), messages: structuredClone(rows) }
    return structuredClone(url.includes('focus=') ? [message('old')] : rows)
  }
  function mount(kind = 'channel') {
    const app = renderer.createApp({ setup() { state = kind === 'channel' ? useChannelMessages(() => scope.value) : useThreadMessages(() => scope.value); return () => null } })
    app.use(VueQueryPlugin, { queryClient: client }); app.mount({}); mounted = app
    return app
  }
  async function eventually(check, label) {
    for (let i = 0; i < 400; i++) { await nextTick(); if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)) }
    assert.fail(label)
  }
  const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
  mount()
  await eventually(() => state.messages.value.length === 1, 'initial live rows')
  assert.equal(calls, 1, 'Query and DB observers must share one initial HTTP request')
  await receiveMessage(client, scope.value, message('m2'))
  await eventually(() => state.messages.value.length === 2, 'live append')
  assert.equal(calls, 1, 'a full message event must not fetch history')
  await receiveMessage(client, scope.value, message('m2', { text: 'duplicate with stale fields' }))
  assert.equal(state.messages.value[1].text, 'm2')
  assert.equal(state.messages.value.length, 2, 'HTTP acknowledgement plus WS echo stays unique')

  const otherAccount = channelMessageOptions({ ...scope.value, userId: 'bob' }).queryKey
  const otherWorkspace = channelMessageOptions({ ...scope.value, workspaceId: 'private' }).queryKey
  client.setQueryData(otherAccount, [message('bob')]); client.setQueryData(otherWorkspace, [message('private')])
  await receiveMessage(client, scope.value, message('m3'))
  assert.equal(client.getQueryData(otherAccount).length, 1); assert.equal(client.getQueryData(otherWorkspace).length, 1)
  assert.equal(client.getQueryCache().findAll({ queryKey: ['messages', 'unloaded'] }).length, 0)
  await receiveMessage(client, scope.value, message('m4', { channelId: 'unloaded' }))
  assert.equal(client.getQueryCache().findAll({ queryKey: ['messages', 'unloaded'] }).length, 0)

  scope.value = { ...scope.value, focus: 'old' }
  await eventually(() => state.messages.value[0]?.id === 'old', 'focused history window')
  const beforeFocusEvent = calls
  await receiveMessage(client, scope.value, message('m4'))
  assert.deepEqual(state.messages.value.map((row) => row.id), ['old']); assert.equal(calls, beforeFocusEvent)
  scope.value = { ...scope.value, focus: undefined, channelId: 'other' }
  rows = [message('other1', { channelId: 'other' })]
  await eventually(() => state.messages.value[0]?.channelId === 'other', 'navigation swaps the collection')
  scope.value = { ...scope.value, userId: undefined }
  await eventually(() => state.messages.value.length === 0, 'logout hides the previous account rows')
  const callsLoggedOut = calls
  await nextTick(); assert.equal(calls, callsLoggedOut)

  fail = true; scope.value = { userId: 'alice', workspaceId: 'main', channelId: 'broken' }
  await eventually(() => state.query.isError.value, 'loading failure remains visible')
  fail = false; rows = [message('recovered', { channelId: 'broken' })]
  await state.query.refetch()
  await eventually(() => state.messages.value[0]?.id === 'recovered', 'retry recovers live rows')

  scope.value = { userId: 'alice', workspaceId: 'main', channelId: 'race' }
  rows = [message('race1', { channelId: 'race' })]
  await eventually(() => state.messages.value[0]?.id === 'race1', 'race baseline')
  const delayed = deferred(); hold = delayed
  const refresh = state.query.refetch()
  await eventually(() => state.query.isFetching.value, 'background fetch started')
  await receiveMessage(client, scope.value, message('race2', { channelId: 'race' }))
  delayed.resolve([message('race1', { channelId: 'race' })]); await refresh
  await eventually(() => state.messages.value.length === 2, 'stale HTTP snapshot must not erase the newer event')

  const initial = deferred(); hold = initial
  scope.value = { userId: 'alice', workspaceId: 'main', channelId: 'initial-race' }
  await eventually(() => state.query.isFetching.value, 'initial fetch started')
  rows = [message('initial1', { channelId: 'initial-race' }), message('initial2', { channelId: 'initial-race' })]
  await receiveMessage(client, scope.value, rows[1])
  initial.resolve([rows[0]])
  await eventually(() => state.messages.value.length === 2, 'event during initial load is recovered after the snapshot')

  rows = []
  await client.invalidateQueries({ queryKey: ['messages', 'initial-race'] })
  await eventually(() => state.messages.value.length === 0, 'authoritative empty snapshot removes deleted messages')
  rows = Array.from({ length: 100 }, (_, index) => message(`bounded${index + 1}`, { channelId: 'initial-race' }))
  await state.query.refetch()
  await receiveMessage(client, scope.value, message('bounded101', { channelId: 'initial-race' }))
  await eventually(() => state.messages.value.at(-1)?.id === 'bounded101', 'latest bounded window appended')
  assert.equal(state.messages.value.length, 100); assert.equal(state.messages.value[0].id, 'bounded2')

  mounted.unmount(); mounted = undefined
  scope.value = { userId: 'alice', workspaceId: 'main', channelId: 'general', threadId: 't1' }
  rows = [message('tmessage1', { threadId: 't1' })]
  const beforeThread = calls
  mount('thread')
  await eventually(() => state.messages.value.length === 1, 'thread messages projected from response envelope')
  assert.equal(calls, beforeThread + 1)
  await receiveMessage(client, scope.value, message('tmessage2', { threadId: 't1' }))
  await eventually(() => state.messages.value.length === 2, 'thread live event')
  assert.equal(calls, beforeThread + 1, 'thread event must not refetch its history')
  assert.equal(state.query.data.value.thread.messageCount, 1, 'bounded rows must not invent an authoritative total')
  await receiveMessage(client, scope.value, message('tmessage2', { threadId: 't1' }))
  assert.equal(state.query.data.value.thread.messageCount, 1, 'duplicate must not inflate thread count')
  assert.equal(state.query.data.value.parent.id, 'parent', 'response metadata remains intact')
  mounted.unmount(); mounted = undefined
  await eventually(() => client.getQueryCache().getAll().every((query) => query.getObserversCount() === 0), 'unmount releases Query and DB observers')
  client.clear()
  console.log('PASS: real Vue Query/DB composables share requests; live append, thread envelopes, retry, account/workspace isolation, navigation/logout, focused history, duplicate echoes, bounded windows, deletion snapshots and both fetch races.')
} finally {
  mounted?.unmount()
  await rm(folder, { recursive: true, force: true })
  delete globalThis.$fetch
}

import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Exercise the actual app-level draft plugin without a browser or DOM renderer.
const folder = await mkdtemp(join(tmpdir(), 'anycord-drafts-'))
const saved = new Map()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) } })
try {
  const output = join(folder, 'plugin.mjs')
  await build({ stdin: { contents: "export { default } from './app/plugins/drafts.client'; export { effectScope } from 'vue'", resolveDir: process.cwd(), loader: 'ts' }, outfile: output, bundle: true, format: 'esm', platform: 'node', banner: { js: 'const defineNuxtPlugin = (plugin) => plugin;' } })
  const { default: plugin, effectScope } = await import(pathToFileURL(output))
  const firstApp = plugin().provide.draftStore
  const componentScope = effectScope()
  const main = componentScope.run(() => firstApp('alice')), thread = firstApp('alice'), bob = firstApp('bob')
  assert.equal(main, thread); assert.notEqual(main, bob)
  main['general:main'] = { text: 'pending main draft', attempt: { id: 'a211dc4a-c7e6-4a3f-85a7-67f5dc3823c1', text: 'pending main draft', channelId: 'general' } }
  thread['general:thread'] = { text: 'new thread draft' }
  main['new-thread:general:root'] = { text: 'first message', threadDraft: { id: 'c1e5fa22-36b6-4c39-a188-9a5f7be6ce7f', name: 'A conversation', createdId: 'server-thread', completedId: 'server-thread' }, attempt: { id: '4c1eb927-6ebf-40ce-b7bc-0aa52e50fb0b', text: 'first message', channelId: 'general', threadId: 'server-thread' } }
  componentScope.stop() // Closing the composer must not dispose persistence for its delayed acknowledgement.
  assert.equal(firstApp('alice')['general:main'].attempt.id, 'a211dc4a-c7e6-4a3f-85a7-67f5dc3823c1')
  // A delayed acknowledgement resolves the owner's current store, even after another composer writes.
  delete firstApp('alice')['general:main']
  const nextApp = plugin().provide.draftStore
  assert.equal(nextApp('alice')['general:main'], undefined)
  assert.equal(nextApp('alice')['general:thread'].text, 'new thread draft')
  assert.deepEqual(Object.keys(nextApp('bob')), [])
  assert.equal(nextApp('alice')['new-thread:general:root'].threadDraft.createdId, 'server-thread')
  assert.equal(nextApp('alice')['new-thread:general:root'].threadDraft.completedId, 'server-thread')
  assert.equal(nextApp('alice')['new-thread:general:root'].attempt.id, '4c1eb927-6ebf-40ce-b7bc-0aa52e50fb0b')
  const controls = plugin().provide
  const loggedOut = controls.draftStore('alice', 'https://one.example')
  loggedOut.general = { text: 'private draft to erase' }
  controls.draftStore('bob', 'https://one.example').general = { text: 'another account' }
  controls.draftStore('alice', 'https://two.example').general = { text: 'another installation' }
  assert.equal(controls.persistDrafts(), true)
  controls.clearDrafts('alice', 'https://one.example')
  loggedOut.general = { text: 'stale composer must not resurrect persisted drafts' }
  assert.deepEqual(Object.keys(plugin().provide.draftStore('alice', 'https://one.example')), [])
  assert.equal(plugin().provide.draftStore('bob', 'https://one.example').general.text, 'another account')
  assert.equal(plugin().provide.draftStore('alice', 'https://two.example').general.text, 'another installation')
  const persist = localStorage.setItem
  localStorage.setItem = () => { throw new Error('storage unavailable') }
  assert.equal(controls.persistDrafts(), false, 'Updating must not reload when drafts cannot be saved')
  localStorage.setItem = persist
  console.log('PASS: composers share an account-scoped draft store; delayed acknowledgement persists without clearing another conversation; another account sees no drafts.')
} finally { await rm(folder, { recursive: true, force: true }); delete globalThis.localStorage }

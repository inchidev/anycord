import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const folder = await mkdtemp(join(tmpdir(), 'anycord-connections-'))
try {
  await build({stdin:{contents:"export * from './app/utils/api'; export * from './app/utils/connection'; export * from './shared/drafts'; export { default as connectionPlugin } from './app/plugins/connections.client'; export { nextTick } from 'vue'",resolveDir:process.cwd(),loader:'ts'},outfile:join(folder,'api.mjs'),bundle:true,format:'esm',platform:'node'})
  globalThis.defineNuxtPlugin = initializer => initializer
  const {apiFor,setApiTarget,connectionOrigin,draftStoreKey,connectionPlugin,nextTick} = await import(pathToFileURL(join(folder,'api.mjs')))
  const calls=[]
  globalThis.$fetch=async (url,options)=>{calls.push({url,...options});return {apiVersion:1,engine:'cloudflare',auth:'better-auth',realtime:'websocket'}}
  setApiTarget({origin:'https://one.example',token:'one'})
  const first=apiFor()
  setApiTarget({origin:'https://two.example',token:'two'})
  await first('runtime');await apiFor()('runtime')
  assert.equal(calls[0].url,'https://one.example/api/runtime');assert.equal(calls[0].headers.Authorization,'Bearer one');assert.equal(calls[0].credentials,'omit')
  assert.equal(calls[1].url,'https://two.example/api/runtime');assert.equal(calls[1].headers.Authorization,'Bearer two')
  setApiTarget({origin:'',token:''});await apiFor()('runtime');assert.equal(calls[2].credentials,'same-origin');assert.equal(calls[2].headers.Authorization,undefined)
  assert.notEqual(draftStoreKey('same-id','https://one.example'),draftStoreKey('same-id','https://two.example'))
  assert.equal(connectionOrigin('https://one.example/'),'https://one.example')
  for(const url of ['http://public.example','https://user:password@one.example','https://one.example/path','javascript:alert(1)'])assert.throws(()=>connectionOrigin(url))
  const persisted = new Map(), sessions = new Map()
  globalThis.localStorage = {getItem:key=>persisted.get(key) ?? null,setItem:(key,value)=>persisted.set(key,value)}
  globalThis.sessionStorage = {getItem:key=>sessions.get(key) ?? null,setItem:(key,value)=>sessions.set(key,value),removeItem:key=>sessions.delete(key)}
  globalThis.location = {origin:'https://home.example',hostname:'home.example'}
  const {provide:{connections}} = connectionPlugin()
  connections.rename('local','  My community  ')
  assert.equal(connections.label.value,'My community');assert.equal(persisted.get('anycord-local-name'),'My community')
  connections.add('https://one.example/','Friends');connections.authenticate('session-for-one')
  connections.rename('https://one.example','  Team  ');await nextTick()
  assert.equal(connections.label.value,'Team');assert.equal(connections.current.value.origin,'https://one.example')
  await apiFor()('runtime');assert.equal(calls.at(-1).headers.Authorization,'Bearer session-for-one')
  connections.select('local');assert.equal(connections.label.value,'My community')
  connections.select('https://one.example');connections.rename('https://one.example','');await nextTick()
  assert.equal(connections.label.value,'one.example')
  const restored = connectionPlugin().provide.connections
  assert.equal(restored.label.value,'one.example');restored.select('local');assert.equal(restored.label.value,'My community')
  restored.show('choose');assert.equal(restored.view.value,'choose');assert.equal(restored.open.value,true)
  console.log('PASS: captured API destination and credentials, local cookie mode, remote draft isolation, remote URL validation, and persistent personal labels without credential changes.')
}finally{await rm(folder,{recursive:true,force:true})}

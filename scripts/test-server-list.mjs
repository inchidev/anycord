import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const folder = await mkdtemp(join(tmpdir(), 'anycord-server-list-'))
let app, client
try {
  const output = join(folder, 'test.mjs')
  await build({ stdin: { contents: `
    export { useInstallationServers } from './app/composables/useInstallationServers'
    export { setApiTarget } from './app/utils/connection'
    export { createRenderer, ref, computed, nextTick } from 'vue'
    export { QueryClient, VueQueryPlugin, useQuery } from '@tanstack/vue-query'
  `, resolveDir: process.cwd(), loader: 'ts' }, outfile: output, bundle: true, format: 'esm', platform: 'node' })
  const { useInstallationServers, setApiTarget, createRenderer, ref, computed, nextTick, QueryClient, VueQueryPlugin, useQuery } = await import(pathToFileURL(output))
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert: (n,p) => { n.parent=p }, remove: () => {}, parentNode: n => n.parent, nextSibling: () => null, setText: () => {}, setElementText: () => {}, patchProp: () => {} })
  const space = id => ({ id, name: id, initials: id.slice(0,2), role: 'owner' })
  const response = workspaces => ({ user: { id:'alice', name:'Alice', color:'#5865f2', role:'owner' }, workspaces:workspaces.map(space), channels:[], members:[] })
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve=done }); return { promise, resolve } }
  let hold, calls=[], state, workspaceState
  globalThis.$fetch = async url => {
    calls.push(url)
    if (url.startsWith('https://remote.example')) return response(['remote-only'])
    if (hold) { const pending=hold; hold=undefined; return pending.promise }
    return response(['main','second'])
  }
  const current = ref('second'), account = ref('alice')
  client = new QueryClient({ defaultOptions:{ queries:{ retry:false, staleTime:15_000 } } })
  // An old per-server bootstrap predates creation of the second server.
  client.setQueryData(['bootstrap','main'],response(['main']))
  app=renderer.createApp({ setup() {
    state=useInstallationServers(() => account.value)
    workspaceState=useQuery({ queryKey:computed(() => ['bootstrap',current.value]), queryFn:() => globalThis.$fetch('/api/bootstrap?workspace='+current.value) })
    return () => null
  } })
  app.use(VueQueryPlugin,{queryClient:client});app.mount({})
  async function until(check,label) { for(let i=0;i<200;i++){await nextTick();if(check())return;await new Promise(r=>setTimeout(r,5))}assert.fail(label) }
  await until(() => state.data.value?.length===2 && workspaceState.data.value,'initial server list')
  current.value='main';await nextTick()
  assert.equal(workspaceState.data.value.workspaces.length,1,'fixture must expose the stale per-server cache')
  assert.deepEqual(state.data.value.map(s=>s.id),['main','second'],'rail must retain both servers across a stale bootstrap switch')
  current.value='unvisited';hold=deferred();const channelLoad=hold
  await until(() => workspaceState.isPending.value,'uncached server is loading')
  assert.deepEqual(state.data.value.map(s=>s.id),['main','second'],'rail must remain visible while new server data is pending')
  channelLoad.resolve(response(['main','second']));await until(() => !workspaceState.isPending.value,'server loaded')
  hold=deferred();const listLoad=hold;const refresh=client.invalidateQueries({queryKey:['server-picker']})
  await until(() => state.isFetching.value,'membership refresh pending')
  assert.equal(state.data.value.length,2,'background refresh must not blank the rail')
  listLoad.resolve(response(['main','second','third']));await refresh
  assert.equal(state.data.value.length,3,'new server membership must appear after refresh')
  hold=deferred();const accountLoad=hold;account.value='bob'
  await until(() => state.isPending.value,'different account is loading')
  assert.equal(state.data.value,undefined,'another account must not see the previous account server list')
  accountLoad.resolve({...response(['bob-only']),user:{id:'bob',name:'Bob',color:'#5865f2',role:'member'}})
  await until(() => state.data.value?.[0]?.id==='bob-only','new account list')
  app.unmount();client.clear()
  // A different connection gets its own QueryClient and captured destination.
  setApiTarget({origin:'https://remote.example',token:'test-token'})
  client=new QueryClient({defaultOptions:{queries:{retry:false}}})
  app=renderer.createApp({setup(){state=useInstallationServers(() => 'alice');return () => null}})
  app.use(VueQueryPlugin,{queryClient:client});app.mount({})
  assert.equal(state.data.value,undefined,'new connection must not expose the previous installation list')
  await until(() => state.data.value?.[0]?.id==='remote-only','remote installation list')
  assert(calls.includes('https://remote.example/api/bootstrap'))
  console.log('PASS: server rail survives stale/pending navigation and membership refresh; accounts and installations have separate lists.')
} finally { app?.unmount();client?.clear();await rm(folder,{recursive:true,force:true}) }

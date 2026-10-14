import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
const source = await readFile('.output/public/sw.js', 'utf8')
assert(!source.includes('__CACHE_ID__') && !source.includes('__PUBLIC_ASSETS__'), 'Build must substitute SW metadata')
const manifest = JSON.parse(await readFile('.output/public/manifest.webmanifest', 'utf8'))
assert.equal(manifest.start_url, '/servers')
assert(manifest.icons.some(icon => icon.purpose === 'maskable'))
const stores = new Map()
function key(request) { return new URL(typeof request === 'string' ? request : request.url, 'https://app.example').pathname }
const caches = {
  async open(name) {
    if (!stores.has(name)) stores.set(name, new Map())
    const data = stores.get(name)
    return { async put(request, response) { data.set(key(request), response.clone()) }, async match(request) { return data.get(key(request))?.clone() } }
  },
  async keys() { return [...stores.keys()] },
  async delete(name) { return stores.delete(name) },
}
let offline = false, failPath = '', skips = 0, claims = 0
const requests = []
function worker(code) {
  const handlers = {}
  const self = { location: { origin: 'https://app.example' }, addEventListener(type, fn) { handlers[type] = fn }, async skipWaiting() { skips++ }, clients: { async claim() { claims++ } } }
  // Browser Request resolves root-relative URLs against the service worker origin.
  class BrowserRequest extends Request { constructor(path, options) { super(new URL(path, self.location.origin), options) } }
  vm.runInNewContext(code, { self, caches, URL, Request: BrowserRequest, Set, console, fetch: async request => {
    requests.push(request)
    if (offline) throw new Error('offline')
    const path = key(request)
    return new Response('public:' + path, { status: path === failPath ? 503 : 200 })
  } })
  async function event(type, extra = {}) {
    const pending = []
    let response
    handlers[type]?.({ ...extra, waitUntil(promise) { pending.push(promise) }, respondWith(promise) { response = promise } })
    await Promise.all(pending)
    return response ? await response : undefined
  }
  return { event }
}
function request(path, options = {}) { return { url: new URL(path, 'https://app.example').href, method: 'GET', mode: 'cors', headers: new Headers(), ...options } }
const first = worker(source)
await first.event('install')
assert.equal(skips, 0, 'Installing an update must not force activation')
const firstCache = (await caches.keys())[0]
assert(stores.get(firstCache).has('/app-shell'))
assert([...stores.get(firstCache).keys()].every(path => !path.startsWith('/api/')))
assert(requests.every(request => request.credentials === 'omit'), 'Precache fetches must exclude credentials')
offline = true
const deep = await first.event('fetch', { request: request('/main/general?thread=thread-id#message-message-id', { mode: 'navigate' }) })
assert.equal(await deep.text(), 'public:/app-shell', 'Offline deep link returns generic shell')
for (const path of ['/api/auth/status', '/api/channels/general/messages', '/api/attachments/file/content?signature=secret', 'https://remote.example/_nuxt/file.js', '/arbitrary-file', '/favicon.png?secret=1']) {
  assert.equal(await first.event('fetch', { request: request(path) }), undefined, 'Private/unlisted URL must bypass SW: ' + path)
}
assert.equal(await first.event('fetch', { request: request('/favicon.png', { method: 'POST' }) }), undefined)
assert.equal(await first.event('fetch', { request: request('/favicon.png', { headers: new Headers({ Authorization: 'Bearer private' }) }) }), undefined)
const asset = [...stores.get(firstCache).keys()].find(path => path.startsWith('/_nuxt/') && path.endsWith('.js'))
assert(asset)
assert.equal(await (await first.event('fetch', { request: request(asset) })).text(), 'public:' + asset)
await first.event('message', { data: { type: 'ACTIVATE_UPDATE' } })
assert.equal(skips, 1)
await first.event('activate'); assert.equal(claims, 1)
offline = false
const second = worker(source.replace(firstCache, 'anycord-public-second'))
await second.event('install'); await second.event('activate')
assert(stores.has(firstCache), 'Preceding generation remains available to older open tabs')
const failed = worker(source.replace(firstCache, 'anycord-public-failed'))
failPath = '/app-shell'
await assert.rejects(() => failed.event('install'))
assert(!stores.has('anycord-public-failed'), 'Partial precache must be removed')
assert(stores.has(firstCache), 'Failed install must preserve the working cache')
failPath = ''
const third = worker(source.replace(firstCache, 'anycord-public-third'))
await third.event('install'); await third.event('activate')
assert.equal(stores.size, 2, 'Bound public cache retention')
assert(stores.has('anycord-public-second') && stores.has('anycord-public-third'))
console.log('PASS: real built SW: offline deep links/public assets; API/auth/private/query/cross-origin/mutation exclusions; explicit activation; failed-install recovery; bounded cache retention.')

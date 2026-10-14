import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile, copyFile } from 'node:fs/promises'
const root = '.output/public'
async function files(dir) {
  const result = []
  for (const item of await readdir(root + dir, { withFileTypes: true })) {
    const path = dir + '/' + item.name
    if (item.isDirectory()) result.push(...await files(path))
    else if (!path.endsWith('.map')) result.push(path)
  }
  return result
}
// Nuxt's generic SPA shell contains no account or conversation data.
await copyFile(root + '/200.html', root + '/app-shell.html')
const assets = ['/app-shell', '/manifest.webmanifest', '/favicon.png', '/brand/anycord-symbol.png', ...await files('/icons'), ...await files('/_nuxt')]
const hash = createHash('sha256')
hash.update(await readFile('shared/build-info.json'))
for (const path of assets.sort()) hash.update(path).update(await readFile(root + (path === '/app-shell' ? '/app-shell.html' : path)))
const template = await readFile('pwa/service-worker.js', 'utf8')
await writeFile(root + '/sw.js', template.replace('__CACHE_ID__', hash.digest('hex').slice(0, 20)).replace('__PUBLIC_ASSETS__', JSON.stringify(assets)))
await copyFile('shared/build-info.json', root + '/version.json')
console.log(`PWA: precaching ${assets.length} public assets; API and private files are network-only.`)

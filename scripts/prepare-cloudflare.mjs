// Prepare public deployment bytes only. Secrets are never part of this archive.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { extname, join } from 'node:path'
const files = [], manifest = {}
const mime = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.woff2': 'font/woff2' }
async function visit(folder) {
  for (const item of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, item.name)
    if (item.isDirectory()) await visit(path)
    else {
      const bytes = await readFile(path), hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32), url = '/' + path.slice('.output/public/'.length)
      files.push({ url, hash, type: mime[extname(path)] || 'application/octet-stream', bytes: bytes.toString('base64') })
      manifest[url] = { hash, size: bytes.length }
    }
  }
}
await visit('.output/public')
const data = { worker: await readFile('runtime/cloudflare/worker.min.js', 'utf8'), manifest, files }
await writeFile('/tmp/anycord-deployment.gz.b64', gzipSync(JSON.stringify(data)).toString('base64'), { mode: 0o600 })
console.log(`${files.length} public assets prepared; worker ${data.worker.length} bytes`)

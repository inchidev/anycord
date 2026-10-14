import assert from 'node:assert/strict'
import { cp, lstat, mkdir, readdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

// Run in the unprivileged build job. Only static assets and the bundled module
// cross into the deployment job; no scripts, lockfiles or Wrangler config do.
const source = resolve(process.argv[2] || '.')
const destination = resolve(process.argv[3] || 'preview-bundle')
let size = 0, files = 0
async function inspect(path) {
  const stat = await lstat(path)
  assert(!stat.isSymbolicLink(), 'Symlinks are forbidden in preview artifacts')
  if (stat.isDirectory()) { for (const entry of await readdir(path)) await inspect(join(path, entry)); return }
  assert(stat.isFile(), 'Only regular files are allowed')
  size += stat.size; files++
  assert(size <= 100 * 1024 * 1024 && files <= 10_000, 'Preview artifact exceeds its size/file limit')
}
await inspect(join(source, 'runtime/cloudflare/worker.js'))
await inspect(join(source, '.output/public'))
const identity = JSON.parse(await readFile(join(source, '.output/public/version.json'), 'utf8'))
assert.equal(identity.commit, process.env.PREVIEW_SHA)
await mkdir(destination, { recursive: true })
await cp(join(source, 'runtime/cloudflare/worker.js'), join(destination, 'worker.js'))
await cp(join(source, '.output/public'), join(destination, 'public'), { recursive: true })
console.log(`Prepared ${files} preview files (${size} bytes)`)

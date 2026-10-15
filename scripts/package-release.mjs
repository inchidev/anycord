import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { releaseManifestSchema } from '../runtime/operations-contracts.mjs'
const info = JSON.parse(await readFile('shared/build-info.json', 'utf8'))
assert(/^[0-9a-f]{40}$/.test(info.commit), 'Release requires a source commit')
assert(/^\d+\.\d+\.\d+$/.test(info.version), 'Release requires a stable version')
assert.deepEqual(JSON.parse(await readFile('.output/public/version.json', 'utf8')), info, 'Client and Worker must be built together')
await mkdir('release', { recursive: true })
const temp = await mkdtemp(join(tmpdir(), 'anycord-release-'))
const artifacts = []
try {
  for (const engine of ['cloudflare', 'celld']) {
    const dir = join(temp, engine)
    await mkdir(dir, { recursive: true })
    for (const [from, to] of [
      ['.output/public', '.output/public'], ['drizzle', 'drizzle'],
      ['shared/build-info.json', 'version.json'], ['DEPLOYMENT.md', 'DEPLOYMENT.md'],
      ['docs/releases.md', 'RELEASES.md'], ['CHANGELOG.md', 'CHANGELOG.md'],
      ['docs/operations.md', 'OPERATIONS.md'], ['operations', 'operations'],
      ['runtime/operations-contracts.mjs', 'operations/contracts.mjs'],
    ]) await cp(from, join(dir, to), { recursive: true })
    const config = JSON.parse(await readFile(engine === 'cloudflare' ? 'wrangler.cloudflare.jsonc' : 'wrangler.jsonc', 'utf8'))
    config.main = 'worker.js'; config.no_bundle = true
    config.assets.directory = '.output/public'; config.d1_databases[0].migrations_dir = 'drizzle'
    if (engine === 'cloudflare') {
      config.name = 'CHOOSE_WORKER_NAME'
      config.d1_databases[0].database_name = 'CHOOSE_DATABASE_NAME'
      config.d1_databases[0].database_id = 'CHOOSE_DATABASE_ID'
      config.r2_buckets[0].bucket_name = 'CHOOSE_PRIVATE_BUCKET'
      config.vars.AUTH_BASE_URL = 'https://CHOOSE_INSTALLATION_ORIGIN'
      await cp('runtime/cloudflare/worker.js', join(dir, 'worker.js'))
      await cp('scripts/configure-release.mjs', join(dir, 'configure.mjs'))
      await cp('scripts/verify-deployment.mjs', join(dir, 'verify-deployment.mjs'))
    } else {
      await cp('runtime/worker.js', join(dir, 'worker.js'))
      await cp('scripts/start.mjs', join(dir, 'scripts/start.mjs'))
      await cp('node_modules/ws', join(dir, 'node_modules/ws'), { recursive: true })
      await cp('Dockerfile.release', join(dir, 'Dockerfile'))
    }
    await writeFile(join(dir, 'wrangler.jsonc'), JSON.stringify(config, null, 2) + '\n')
    const name = `anycord-${info.version}-${engine}.tar.gz`
    execFileSync('tar', ['-czf', join(process.cwd(), 'release', name), '-C', dir, '.'])
    const bytes = await readFile(join('release', name))
    artifacts.push({ name, engine, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length })
  }
  const compatibility = JSON.parse(await readFile('release-upgrade.json', 'utf8'))
  const manifest = releaseManifestSchema.parse({ format: 1, ...info, upgrade: compatibility, engines: ['cloudflare', 'celld'], artifacts })
  await writeFile('release/anycord-release.json', JSON.stringify(manifest, null, 2) + '\n')
  const files = [...artifacts.map(x => x.name), 'anycord-release.json']
  const sums = await Promise.all(files.map(async name => `${createHash('sha256').update(await readFile(join('release', name))).digest('hex')}  ${name}`))
  await writeFile('release/SHA256SUMS', sums.join('\n') + '\n')
  console.log(`Packaged Anycord ${info.version} at ${info.commit} for ${manifest.engines.join(', ')}`)
} finally { await rm(temp, { recursive: true, force: true }) }

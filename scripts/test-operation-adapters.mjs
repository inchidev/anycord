import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { prepareRelease } from '../operations/core.mjs'
import { activateCloudflare, activateCelld } from '../operations/activate.mjs'

const root = await mkdtemp(join(tmpdir(), 'anycord-adapters-'))
const hash = value => createHash('sha256').update(value).digest('hex')
try {
  const info = JSON.parse(await readFile('shared/build-info.json', 'utf8'))
  const packageDir = join(root, 'package'); await mkdir(join(packageDir, '.output/public'), { recursive: true })
  await cp('drizzle', join(packageDir, 'drizzle'), { recursive: true })
  for (const path of ['version.json', '.output/public/version.json']) await writeFile(join(packageDir, path), JSON.stringify(info))
  async function archiveTransport({ corrupt = false, mismatch = false, symlinked = false, immutable = true, incompatible = false } = {}) {
    if (symlinked) await symlink('/private/never-read', join(packageDir, 'unsafe-link'))
    const archive = join(root, 'artifact.tar.gz'); execFileSync('tar', ['-czf', archive, '-C', packageDir, '.'])
    if (symlinked) await rm(join(packageDir, 'unsafe-link'))
    const bytes = await readFile(archive), name = `anycord-${info.version}-cloudflare.tar.gz`
    const manifest = JSON.stringify({ format: 1, ...info, ...(incompatible ? { schema: 'unknown' } : {}), engines: ['cloudflare'], artifacts: [{ name, engine: 'cloudflare', size: bytes.length, sha256: hash(bytes) }] })
    const sums = `${mismatch ? '0'.repeat(64) : hash(manifest)}  anycord-release.json\n${hash(bytes)}  ${name}\n`
    const assets = [{ name, digest: 'sha256:' + hash(bytes) }, { name: 'anycord-release.json', digest: 'sha256:' + hash(manifest) }, { name: 'SHA256SUMS', digest: 'sha256:' + hash(sums) }]
    return async url => {
      if (url.startsWith('https://api.github.com/')) return Response.json({ immutable, draft: false, prerelease: false, tag_name: 'v' + info.version, assets })
      if (url.endsWith('/anycord-release.json')) return new Response(manifest)
      if (url.endsWith('/SHA256SUMS')) return new Response(sums)
      if (url.endsWith('/' + name)) return new Response(corrupt ? Buffer.alloc(bytes.length) : bytes)
      throw new Error('Unexpected release request')
    }
  }
  const prepared = await prepareRelease(info.version, 'cloudflare', join(root, 'valid'), info, await archiveTransport())
  assert.deepEqual(prepared.manifest.commit, info.commit)
  for (const [name, options, message] of [
    ['corrupt', { corrupt: true }, /integrity/], ['checksum', { mismatch: true }, /checksum/],
    ['symlink', { symlinked: true }, /only files/], ['mutable', { immutable: false }, /immutable/],
    ['schema', { incompatible: true }, /schema upgrade/],
  ]) await assert.rejects(prepareRelease(info.version, 'cloudflare', join(root, name), info, await archiveTransport(options)), message)

  const installation = { accountId: 'a'.repeat(32), workerName: 'existing-chat', databaseId: '1'.repeat(8) + '-1111-1111-1111-' + '1'.repeat(12), databaseName: 'existing-db', bucketName: 'existing-files', origin: 'https://chat.example.com', customDomain: true }
  const installationFile = join(root, 'installation.json'); await writeFile(installationFile, JSON.stringify(installation))
  const bindings = [{ name: 'DB', type: 'd1', database_id: installation.databaseId }, { name: 'FILES', type: 'r2_bucket', bucket_name: installation.bucketName }, { name: 'AUTH_BASE_URL', type: 'plain_text', text: installation.origin }, { name: 'APP_SECRET', type: 'secret_text' }, { name: 'ROOMS', type: 'durable_object_namespace', namespace_id: 'existing-namespace', class_name: 'ChatRoom' }]
  const cloudflare = { origin: installation.origin, cloudflare: { installationFile, wrangler: '/operator/pinned-wrangler', tokenEnv: 'ANYCORD_ADAPTER_TEST_TOKEN' } }
  process.env.ANYCORD_ADAPTER_TEST_TOKEN = 'fake-local-provider-token'
  async function cloudflareRun({ wrongOrigin = false, wrongDatabase = false, lostBinding = false } = {}) {
    const dir = join(root, 'cf-' + crypto.randomUUID()); await mkdir(dir); let deployed = false, commands = []
    const transport = async url => {
      if (url.includes('/domains?')) return Response.json({ success: true, result: [{ hostname: wrongOrigin ? 'other.example.com' : 'chat.example.com', service: installation.workerName, enabled: true }, { hostname: 'second.example.com', service: installation.workerName, enabled: true }] })
      if (url.endsWith('/subdomain')) return Response.json({ success: true, result: { enabled: false, previews_enabled: false } })
      if (url.endsWith('/settings')) return Response.json({ success: true, result: { bindings: bindings.map(b => wrongDatabase && b.name === 'DB' ? { ...b, database_id: 'wrong' } : (deployed && lostBinding && b.name === 'ROOMS' ? { ...b, namespace_id: 'wrong' } : b)) } })
      throw new Error('Unexpected account request')
    }
    const run = async argv => {
      commands.push(argv)
      if (argv[1] === 'configure.mjs') await writeFile(join(dir, 'wrangler.jsonc'), JSON.stringify({ vars: {}, d1_databases: [{ binding: 'DB' }], r2_buckets: [{ binding: 'FILES' }], durable_objects: { bindings: [{ name: 'ROOMS' }] } }))
      else { assert.deepEqual(argv.slice(0, 2), ['/operator/pinned-wrangler', 'deploy']); const candidate = JSON.parse(await readFile(argv[3], 'utf8')); assert.equal(candidate.vars.AUTH_BASE_URL, installation.origin); assert.deepEqual(candidate.routes.map(r=>r.pattern).sort(), ['chat.example.com','second.example.com']); assert.equal(candidate.workers_dev,false); deployed = true }
      return { stdout: '' }
    }
    return { attempt: () => activateCloudflare({ directory: dir }, cloudflare, { transport, run }), commands }
  }
  await (await cloudflareRun()).attempt()
  for (const [options, message] of [[{ wrongOrigin: true }, /Origin/], [{ wrongDatabase: true }, /database/], [{ lostBinding: true }, /binding/]]) {
    const test = await cloudflareRun(options); await assert.rejects(test.attempt(), message)
    if (!options.lostBinding) assert.equal(test.commands.length, 0, 'Refuse wrong resources before activation')
  }
  async function celldRun({ wrongVolume = false, wrongStorage = false } = {}) {
    const commands = [], mount = { Destination: '/app/.celld', Source: '/docker/volumes/existing/_data', Name: 'existing-state' }, image = `anycord:${info.version}-${info.commit.slice(0, 12)}`
    const run = async (argv, options = {}) => {
      commands.push(argv)
      if (argv.includes('ps')) return { stdout: 'container-id\n' }
      if (argv.includes('inspect')) return { stdout: JSON.stringify([{ Mounts: [mount], Config: { Image: commands.some(c => c.includes('up')) ? image : 'previous', Env: ['STORAGE_BUCKET=existing-files'] } }]) }
      if (argv.includes('config')) { assert.equal(options.env.ANYCORD_IMAGE, image); return { stdout: JSON.stringify({ services: { chat: { image, environment: { AUTH_BASE_URL: installation.origin, STORAGE_BUCKET: wrongStorage ? 'wrong' : 'existing-files' }, volumes: [{ target: '/app/.celld', source: 'state', type: 'volume' }] } }, volumes: { state: { name: wrongVolume ? 'new-state' : 'existing-state' } } }) } }
      assert(argv.includes('build') || argv.includes('up')); return { stdout: '' }
    }
    return { commands, attempt: () => activateCelld({ manifest: info, directory: root }, { origin: installation.origin, celld: { composeFile: '/operator/compose.yml', project: 'existing', service: 'chat' } }, { run }) }
  }
  await (await celldRun()).attempt()
  for (const [options, message] of [[{ wrongVolume: true }, /state volume/], [{ wrongStorage: true }, /STORAGE_BUCKET/]]) {
    const test = await celldRun(options); await assert.rejects(test.attempt(), message); assert(!test.commands.some(c => c.includes('build') || c.includes('up')), 'Refuse state/storage changes before replacement')
  }
  console.log('PASS operations adapters: immutable/checksummed packages, corrupted/checksum/symlink/schema refusal; Cloudflare origin/DB/binding preservation; celld state/storage preservation and pre-activation refusal')
} finally { delete process.env.ANYCORD_ADAPTER_TEST_TOKEN; await rm(root, { recursive: true, force: true }) }

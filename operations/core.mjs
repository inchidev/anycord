import assert from 'node:assert/strict'
import { existsSync, createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile, readdir, rename, rm, lstat, realpath, open } from 'node:fs/promises'
import { createHash, randomUUID, webcrypto } from 'node:crypto'
import { resolve, join, dirname, relative, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
const exec = promisify(execFile)
const contractPath = existsSync(new URL('./contracts.mjs', import.meta.url)) ? './contracts.mjs' : '../runtime/operations-contracts.mjs'
const { backupManifestSchema, releaseManifestSchema, backupTables, stableVersion } = await import(new URL(contractPath, import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const repository = 'inchidev/anycord'
export function installationOrigin(value) {
  const url = new URL(value)
  assert.equal(url.origin, value, 'Use a plain installation origin without credentials or paths')
  assert(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)), 'Operations require HTTPS or loopback')
  return value
}
export function operationClient(config, transport = fetch) {
  const origin = installationOrigin(config.origin)
  return async (path, { method = 'GET', body, key, raw = false } = {}) => {
    // Re-read a token file after a self-hosted process restart.
    const token = config.migrationTokenFile ? (await readFile(config.migrationTokenFile, 'utf8')).trim() : process.env[config.migrationTokenEnv || 'ANYCORD_MIGRATION_TOKEN']
    assert(token, 'Configure the installation migration token in a private file or environment')
    const response = await transport(origin + '/api/_operations' + path, { method, headers: { 'X-Migration-Token': token, ...(key ? { 'X-Operation-Key': key } : {}), ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}) }, ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(60_000), redirect: 'error' })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Installation operation failed (${response.status}) at ${path.split('?')[0]}`) }
    return raw ? response : response.json()
  }
}
async function privateDirectory(path) { await mkdir(path, { recursive: true, mode: 0o700 }); assert(!(await lstat(path)).isSymbolicLink(), 'Backup directories cannot be symlinks') }
async function privateWrite(path, bytes) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, bytes, { mode: 0o600, flag: 'wx' }) }
async function fileIdentity(path) { const digest = createHash('sha256'); let size = 0; for await (const chunk of createReadStream(path)) { digest.update(chunk); size += chunk.length } return { size, sha256: digest.digest('hex') } }
function checkedPath(root, value) {
  assert(typeof value === 'string' && value && !value.includes('\\') && !value.includes('\0'), 'Invalid backup path')
  const path = resolve(root, value), suffix = relative(resolve(root), path)
  assert(suffix && !suffix.startsWith('..' + sep) && suffix !== '..' && !suffix.startsWith(sep), 'Backup path escapes its directory')
  return path
}
export async function* records(path) {
  let pending = ''
  for await (const chunk of createReadStream(path, { encoding: 'utf8', highWaterMark: 65536 })) {
    pending += chunk
    let end
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1)
      assert(Buffer.byteLength(line) <= 1_000_000, 'Backup record exceeds size limit')
      if (line) yield JSON.parse(line)
    }
    assert(Buffer.byteLength(pending) <= 1_000_000, 'Backup record exceeds size limit')
  }
  if (pending) yield JSON.parse(pending)
}
async function decryptSetting(value, secret) {
  const [iv, data] = value.split(':'); assert(iv && data, 'Invalid encrypted setting')
  const key = await webcrypto.subtle.importKey('raw', createHash('sha256').update(secret).digest(), 'AES-GCM', false, ['decrypt'])
  return new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'hex') }, key, Buffer.from(data, 'hex')))
}
export async function verifyBackup(root) {
  assert((await lstat(root)).isDirectory() && !(await lstat(root)).isSymbolicLink(), 'Backup root must be a real directory')
  assert((await lstat(join(root, 'manifest.json'))).isFile() && !(await lstat(join(root, 'manifest.json'))).isSymbolicLink(), 'Backup manifest must be a regular file')
  const manifest = backupManifestSchema.parse(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')))
  assert.deepEqual(manifest.tables.map(t => t.name).sort(), [...backupTables].sort(), 'Backup must contain exactly the supported application tables')
  const all = [...manifest.tables, ...manifest.objects, manifest.secrets], paths = new Set()
  const realRoot = await realpath(root)
  for (const entry of all) {
    const path = checkedPath(root, entry.path); assert(!paths.has(path), 'Duplicate backup path'); paths.add(path)
    const stat = await lstat(path); assert(stat.isFile() && !stat.isSymbolicLink(), 'Backup payload must be a regular file')
    assert((await realpath(path)).startsWith(realRoot + sep), 'Backup payload follows an external symlink')
    assert.deepEqual(await fileIdentity(path), { size: entry.size, sha256: entry.sha256 }, 'Backup payload integrity failure')
  }
  const secrets = JSON.parse(await readFile(checkedPath(root, manifest.secrets.path), 'utf8')); assert(typeof secrets.APP_SECRET === 'string' && secrets.APP_SECRET.length >= 32, 'Backup encryption key missing')
  for (const table of manifest.tables) {
    let count = 0
    for await (const row of records(checkedPath(root, table.path))) {
      assert.deepEqual(Object.keys(row).sort(), [...table.columns].sort(), 'Backup record columns differ from manifest')
      assert(Object.values(row).every(v => v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))), 'Backup values must be SQLite scalar values')
      if (table.name === 'settings' && ['authentication', 'openrouterKey', 'realtimeToken'].includes(row.key) && row.value) await decryptSetting(row.value, secrets.APP_SECRET)
      if (table.name === 'storage_configs') await decryptSetting(row.config, secrets.APP_SECRET)
      count++
    }
    assert.equal(count, table.rows, 'Backup record count mismatch')
  }
  const attachments = manifest.tables.find(t => t.name === 'attachments'), objects = new Map(manifest.objects.map(o => [o.id, o])); assert.equal(objects.size, manifest.objects.length)
  let count = 0
  for await (const row of records(checkedPath(root, attachments.path))) { const object = objects.get(row.id); assert(object && object.size === row.size && row.status === 'uploaded' && row.message_id, 'Committed attachment inventory mismatch'); count++ }
  assert.equal(count, manifest.objects.length, 'Backup contains orphan/missing attachment objects')
  return { manifest, secrets, manifestHash: hash(await readFile(join(root, 'manifest.json'))) }
}
export async function createBackup(client, job, key, directory) {
  await privateDirectory(directory)
  const id = randomUUID(), staging = join(directory, '.partial-' + id), final = join(directory, id)
  await mkdir(staging, { mode: 0o700 })
  await client(`/jobs/${job.id}/snapshot`, { method: 'POST', key, body: {} })
  const meta = await client(`/jobs/${job.id}/manifest`, { key })
  const manifest = { format: 1, id, ...meta, tables: [], objects: [] }
  for (const table of meta.tables) {
    const path = `tables/${table.name}.jsonl`; await mkdir(join(staging, 'tables'), { recursive: true, mode: 0o700 })
    const file = await open(join(staging, path), 'wx', 0o600); let cursor = 0, count = 0
    try {
      while (true) {
        const page = await client(`/jobs/${job.id}/tables/${table.name}?cursor=${cursor}`, { key })
        if (page.rows.length) await file.writeFile(page.rows.map(row => JSON.stringify(row) + '\n').join('')); count += page.rows.length
        if (!page.rows.length) break
        assert(page.cursor > cursor, 'Snapshot cursor did not advance'); cursor = page.cursor
      }
    } finally { await file.close() }
    assert.equal(count, table.rows, 'The frozen table changed during export')
    manifest.tables.push({ ...table, path, ...await fileIdentity(join(staging, path)) })
  }
  const secretBytes = Buffer.from(JSON.stringify(await client(`/jobs/${job.id}/secrets`, { key })) + '\n')
  await privateWrite(join(staging, 'private/secrets.json'), secretBytes)
  manifest.secrets = { path: 'private/secrets.json', size: secretBytes.length, sha256: hash(secretBytes) }
  for await (const row of records(join(staging, 'tables/attachments.jsonl'))) {
    const path = 'objects/' + row.id; await mkdir(join(staging, 'objects'), { recursive: true, mode: 0o700 })
    const response = await client(`/jobs/${job.id}/objects/${row.id}`, { key, raw: true })
    let bytes = 0
    const limiter = new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; callback(bytes > row.size ? new Error('Attachment exceeded its inventory size') : null, chunk) } })
    await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(join(staging, path), { flags: 'wx', mode: 0o600 }))
    assert.equal(bytes, row.size)
    manifest.objects.push({ id: row.id, path, ...await fileIdentity(join(staging, path)) })
  }
  await privateWrite(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  const verified = await verifyBackup(staging)
  await rename(staging, final)
  const result = { backupId: id, manifestHash: verified.manifestHash, files: manifest.objects.length, bytes: [...manifest.tables, ...manifest.objects, manifest.secrets].reduce((sum, f) => sum + f.size, 0) }
  await client(`/jobs/${job.id}/checkpoint`, { method: 'POST', key, body: result })
  return { path: final, ...verified, result }
}
export async function restoreBackup(client, backupPath, runnerId, { resumeId } = {}) {
  // Validate every file, record, count, inventory and encryption key before
  // acquiring the destination lock or changing any installation data.
  const { manifest, secrets, manifestHash } = await verifyBackup(backupPath), status = await client('/status')
  assert.equal(status.build.apiVersion, manifest.build.apiVersion); assert.equal(status.build.schema, manifest.build.schema, 'Install the matching schema before restore')
  let id = resumeId || randomUUID()
  if (resumeId) {
    const job = status.jobs.find(j => j.id === resumeId)
    assert(job?.kind === 'restore' && job.checkpoint === manifest.id && job.result?.manifestHash === manifestHash, 'Resume requires the original verified restore backup')
  } else await client('/restore', { method: 'POST', body: { id, installationId: status.installationId, sourceBuild: manifest.build, backupId: manifest.id, manifestHash } })
  const claim = await client('/claim', { method: 'POST', body: { runnerId, ...(resumeId ? { resumeId } : {}) } }); assert.equal(claim.job?.id, id)
  const { key } = claim
  try {
    await client(`/jobs/${id}/restore-reset`, { method: 'POST', key, body: {} })
    // Messages/threads have cyclic references. Insert messages with null links,
    // restore all parents/threads, then reattach the original references.
    const order = ['app_migrations', 'users', 'auth_user', 'auth_account', 'workspaces', 'memberships', 'channels', 'settings', 'storage_configs', 'messages', 'threads', 'reactions', 'attachments', 'invitations', 'recovery_keys', 'workspace_bans', 'telegram_preferences', 'thread_followers']
    async function restoreTable(name, links = false) {
      const table = manifest.tables.find(t => t.name === name); let rows = []
      const send = async () => { if (rows.length) await client(`/jobs/${id}/tables/${name}`, { method: 'POST', key, body: { rows, links, backupSecret: secrets.APP_SECRET } }); rows = [] }
      for await (const row of records(checkedPath(backupPath, table.path))) { rows.push(row); if (rows.length === 25) await send() }
      await send()
    }
    for (const table of order) await restoreTable(table)
    await restoreTable('messages', true)
    await client(`/jobs/${id}/progress`, { method: 'POST', key, body: { phase: 'restore-files' } })
    for (const file of manifest.objects) {
      // Application attachments are bounded individually, unlike the total backup.
      const bytes = await readFile(checkedPath(backupPath, file.path))
      await client(`/jobs/${id}/objects/${file.id}`, { method: 'PUT', key, body: bytes, raw: true })
      const response = await client(`/jobs/${id}/objects/${file.id}`, { key, raw: true })
      assert.equal(hash(Buffer.from(await response.arrayBuffer())), file.sha256, 'Restored attachment readback failed')
    }
    for (const table of manifest.tables) {
      let rows = []
      const send = async () => { if (rows.length) await client(`/jobs/${id}/verify-table`, { method: 'POST', key, body: { table: table.name, rows, restored: true, backupSecret: secrets.APP_SECRET } }); rows = [] }
      for await (const row of records(checkedPath(backupPath, table.path))) { rows.push(row); if (rows.length === 25) await send() }
      await send()
    }
    await client(`/jobs/${id}/finish`, { method: 'POST', key, body: { success: true, result: { files: manifest.objects.length } } })
    return { id, installationId: status.installationId, files: manifest.objects.length }
  } catch (error) {
    await client(`/jobs/${id}/finish`, { method: 'POST', key, body: { success: false } }).catch(() => {})
    throw new Error(`Restore ${id} is incomplete and remains in maintenance. Resume this ID after fixing the destination.`, { cause: error })
  }
}
export async function retainBackups(directory, installationId, keep, pinned = new Set()) {
  assert(Number.isInteger(keep) && keep >= 2)
  const verified = []
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9-]{36}$/.test(name)) continue
    const root = join(directory, name)
    try { const backup = await verifyBackup(root); if (backup.manifest.installationId === installationId) verified.push({ name, createdAt: backup.manifest.createdAt }) } catch { /* Never automatically delete corrupt/partial/foreign data. */ }
  }
  verified.sort((a, b) => b.createdAt - a.createdAt)
  for (const backup of verified.slice(keep)) if (!pinned.has(backup.name)) await rm(join(directory, backup.name), { recursive: true })
}

async function textBounded(response) {
  assert(response.ok, `Release metadata unavailable (${response.status})`)
  const chunks = []; let size = 0
  for await (const chunk of Readable.fromWeb(response.body)) { size += chunk.length; assert(size <= 512_000, 'Release metadata too large'); chunks.push(chunk) }
  return Buffer.concat(chunks).toString('utf8')
}
async function jsonBounded(response) { return JSON.parse(await textBounded(response)) }
export async function migrateInstallation(config, transport = fetch) {
  const token = config.migrationTokenFile ? (await readFile(config.migrationTokenFile, 'utf8')).trim() : process.env[config.migrationTokenEnv || 'ANYCORD_MIGRATION_TOKEN']
  for (let i = 0; i < 30; i++) {
    try { const response = await transport(config.origin + '/api/_migrate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Migration-Token': token }, body: '{}', redirect: 'error', signal: AbortSignal.timeout(30_000) }); if (response.ok) return; await response.body?.cancel() } catch {}
    await delay(2000)
  }
  throw new Error('Authenticated application migrations did not complete')
}
export async function verifyRecoveryPoint(client, job, key, path) {
  const backup = await verifyBackup(path), current = await client(`/jobs/${job.id}/manifest`, { key })
  const recorded = (await client('/status')).jobs.find(j => j.id === job.id)
  assert(recorded?.checkpoint === backup.manifest.id && recorded.result?.manifestHash === backup.manifestHash, 'Recovery point differs from the checkpoint recorded before deployment')
  assert.equal(current.installationId, backup.manifest.installationId, 'Installation identity changed during update')
  const secrets = await client(`/jobs/${job.id}/secrets`, { key })
  for (const name of ['APP_SECRET', 'MIGRATION_TOKEN', 'SETUP_TOKEN']) assert((secrets[name] || '') === (backup.secrets[name] || ''), `Update changed ${name}`)
  for (const table of backup.manifest.tables) {
    let rows = []
    const send = async () => { if (rows.length) await client(`/jobs/${job.id}/verify-table`, { method: 'POST', key, body: { table: table.name, rows } }); rows = [] }
    for await (const row of records(checkedPath(path, table.path))) { rows.push(row); if (rows.length === 25) await send() }
    await send()
  }
  for (const file of backup.manifest.objects) { const response = await client(`/jobs/${job.id}/objects/${file.id}`, { key, raw: true }); const digest = createHash('sha256'); let size = 0; for await (const chunk of Readable.fromWeb(response.body)) { size += chunk.length; assert(size <= file.size); digest.update(chunk) } assert.equal(size, file.size); assert.equal(digest.digest('hex'), file.sha256, 'Update changed a private attachment') }
}
export async function prepareRelease(version, engine, directory, sourceBuild, transport = fetch) {
  stableVersion.parse(version); assert(['cloudflare', 'celld'].includes(engine))
  const metadata = await jsonBounded(await transport(`https://api.github.com/repos/${repository}/releases/tags/v${version}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Anycord-operations' }, signal: AbortSignal.timeout(30_000) }))
  assert(metadata.immutable && !metadata.draft && !metadata.prerelease && metadata.tag_name === 'v' + version, 'Only a complete immutable stable release can be used')
  const base = `https://github.com/${repository}/releases/download/v${version}`
  async function releaseText(name) {
    const asset = metadata.assets?.find(a => a.name === name)
    assert(asset, 'Immutable release is missing a required asset')
    const text = await textBounded(await transport(base + '/' + name, { signal: AbortSignal.timeout(30_000) }))
    if (asset.digest) assert.equal(asset.digest, 'sha256:' + hash(text), 'Published asset digest mismatch')
    return text
  }
  const manifestText = await releaseText('anycord-release.json'), manifest = releaseManifestSchema.parse(JSON.parse(manifestText))
  const sumsText = await releaseText('SHA256SUMS'), sums = new Map()
  for (const line of sumsText.trim().split('\n')) { const match = /^([a-f0-9]{64})  ([a-zA-Z0-9._-]+)$/.exec(line); assert(match && !sums.has(match[2]), 'Invalid published checksum inventory'); sums.set(match[2], match[1]) }
  assert.equal(sums.get('anycord-release.json'), hash(manifestText), 'Release manifest checksum mismatch')
  assert.equal(manifest.version, version); assert.equal(manifest.apiVersion, sourceBuild.apiVersion); assert(manifest.engines.includes(engine))
  if (manifest.schema !== sourceBuild.schema) assert(manifest.upgrade?.migrations === 'backward-compatible' && manifest.upgrade.fromSchemas.includes(sourceBuild.schema), 'This schema upgrade is not explicitly declared compatible')
  const artifact = manifest.artifacts.find(a => a.engine === engine)
  assert(artifact && artifact.name === `anycord-${version}-${engine}.tar.gz`, 'Unexpected artifact identity')
  assert.equal(sums.get(artifact.name), artifact.sha256, 'Artifact checksum inventory mismatch')
  const asset = metadata.assets.find(a => a.name === artifact.name); assert(asset && (!asset.digest || asset.digest === 'sha256:' + artifact.sha256), 'Published artifact identity mismatch')
  assert(artifact.size <= 512 * 1024 * 1024, 'Release artifact exceeds the operator limit')
  await privateDirectory(directory)
  const archive = join(directory, artifact.name)
  if (existsSync(archive)) { const stat = await lstat(archive); assert(stat.isFile() && !stat.isSymbolicLink(), 'Cached release must be a regular file'); const cached = await fileIdentity(archive); if (cached.size !== artifact.size || cached.sha256 !== artifact.sha256) await rm(archive) }
  if (!existsSync(archive)) {
    await rm(archive + '.partial', { force: true })
    const response = await transport(base + '/' + artifact.name, { signal: AbortSignal.timeout(300_000) }); assert(response.ok)
    let bytes = 0
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, callback) { bytes += chunk.length; callback(bytes > artifact.size ? new Error('Release archive too large') : null, chunk) } }), createWriteStream(archive + '.partial', { flags: 'wx', mode: 0o600 }))
    await rename(archive + '.partial', archive)
  }
  assert.deepEqual(await fileIdentity(archive), { size: artifact.size, sha256: artifact.sha256 }, 'Release archive integrity failure')
  const listing = (await exec('tar', ['-tvzf', archive], { maxBuffer: 16 * 1024 * 1024 })).stdout
  assert(listing.split('\n').filter(Boolean).every(line => line.startsWith('-') || line.startsWith('d')), 'Release archives may contain only files/directories')
  const paths = (await exec('tar', ['-tzf', archive], { maxBuffer: 16 * 1024 * 1024 })).stdout.split('\n').filter(Boolean)
  assert(paths.every(p => !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\\')), 'Unsafe release archive path')
  const extracted = join(directory, 'extracted')
  await rm(extracted, { recursive: true, force: true }); await mkdir(extracted, { mode: 0o700 })
  await exec('tar', ['-xzf', archive, '-C', extracted])
  const journal = JSON.parse(await readFile(join(extracted, 'drizzle/meta/_journal.json'), 'utf8')).entries.map(e => e.tag)
  assert.equal(new Set(journal).size, journal.length); assert.equal(journal.at(-1), manifest.schema); assert(journal.includes(sourceBuild.schema), 'Release omits the installed migration history')
  for (const tag of journal) assert(existsSync(join(extracted, 'drizzle', tag + '.sql')), 'Release omits a migration file')
  const packaged = JSON.parse(await readFile(join(extracted, 'version.json'), 'utf8'))
  assert.deepEqual(packaged, { version: manifest.version, commit: manifest.commit, apiVersion: manifest.apiVersion, schema: manifest.schema }, 'Packaged identity mismatch')
  const client = JSON.parse(await readFile(join(extracted, '.output/public/version.json'), 'utf8')); assert.deepEqual(client, packaged)
  return { manifest, directory: extracted }
}
export async function verifyInstallation(origin, expected, transport = fetch) {
  for (let i = 0; i < 30; i++) {
    try {
      const health = await jsonBounded(await transport(origin + '/api/health', { cache: 'no-store', signal: AbortSignal.timeout(10_000) }))
      const client = await jsonBounded(await transport(origin + '/version.json', { cache: 'no-store', signal: AbortSignal.timeout(10_000) }))
      if (health.ok && health.schema === expected.schema && JSON.stringify(health.build) === JSON.stringify(expected) && JSON.stringify(client) === JSON.stringify(expected)) return
    } catch {}
    await delay(2000)
  }
  throw new Error('Updated client/Worker identity or schema did not become healthy')
}
export async function executeJob(client, job, key, config, { activate, prepare = prepareRelease, verify = verifyInstallation, migrate = migrateInstallation } = {}) {
  try {
    if (job.kind === 'backup') {
      const backup = await createBackup(client, job, key, config.backupDirectory)
      const state = await client('/status')
      await retainBackups(config.backupDirectory, state.installationId, state.policy.retainBackups, new Set(state.jobs.filter(j => j.checkpoint && j.kind === 'update' && j.status !== 'complete').map(j => j.checkpoint)))
      return backup
    }
    assert.equal(job.kind, 'update', 'Restore is an explicit separate command')
    const before = await client('/status'), expected = { version: job.targetVersion, commit: job.targetCommit, apiVersion: job.targetApiVersion, schema: job.targetSchema }
    assert.equal(before.engine, config.engine, 'Configured activation engine differs from the installation')
    // If a runner stopped after deployment, prove the exact target before
    // retrying any activation. The job's checkpoint remains pinned.
    if (before.build.version === job.targetVersion && before.build.commit === job.targetCommit) {
      assert(job.checkpoint, 'Interrupted update has no recovery point')
      assert.deepEqual(before.build, expected, 'Interrupted deployment has the wrong API/schema')
      await migrate(config)
      await verify(config.origin, expected)
      await verifyRecoveryPoint(client, job, key, join(config.backupDirectory, job.checkpoint))
      await client(`/jobs/${job.id}/finish`, { method: 'POST', key, body: { success: true, result: { version: job.targetVersion } } })
      return { resumedAfterDeployment: true }
    }
    const release = await prepare(job.targetVersion, before.engine, join(config.releaseDirectory, job.targetVersion), before.build)
    assert.equal(release.manifest.commit, job.targetCommit, 'Release identity changed after approval')
    assert.equal(release.manifest.schema, job.targetSchema); assert.equal(release.manifest.apiVersion, job.targetApiVersion)
    let checkpoint
    if (job.checkpoint) {
      checkpoint = await verifyBackup(join(config.backupDirectory, job.checkpoint))
      assert.equal(checkpoint.manifestHash, job.result?.manifestHash)
      assert(JSON.stringify(checkpoint.manifest.build) === JSON.stringify(before.build) || JSON.stringify(checkpoint.manifest.build) === JSON.stringify(expected), 'Installation changed since the approved recovery point')
    } else checkpoint = await createBackup(client, job, key, config.backupDirectory)
    // Check the complete recovery point again immediately before activation.
    await verifyBackup(checkpoint.path || join(config.backupDirectory, job.checkpoint))
    await client(`/jobs/${job.id}/progress`, { method: 'POST', key, body: { phase: 'deploying' } })
    assert(activate, 'Configure a trusted engine activation adapter')
    await activate(release, config)
    await migrate(config)
    await client(`/jobs/${job.id}/progress`, { method: 'POST', key, body: { phase: 'verifying' } })
    const target = { version: release.manifest.version, commit: release.manifest.commit, apiVersion: release.manifest.apiVersion, schema: release.manifest.schema }
    await verify(config.origin, target)
    await verifyRecoveryPoint(client, job, key, checkpoint.path || join(config.backupDirectory, job.checkpoint))
    await client(`/jobs/${job.id}/finish`, { method: 'POST', key, body: { success: true, result: { version: job.targetVersion } } })
    return { version: job.targetVersion }
  } catch (error) {
    await client(`/jobs/${job.id}/finish`, { method: 'POST', key, body: { success: false } }).catch(() => {})
    throw new Error(`Operation ${job.id} failed; its verified recovery point is retained. Resume explicitly after inspecting the runner and installation.`, { cause: error })
  }
}
export const runCommand = async (argv, options = {}) => {
  assert(Array.isArray(argv) && argv.length && argv.every(x => typeof x === 'string' && x && !x.includes('\0')), 'Activation commands must be fixed argv arrays')
  return exec(argv[0], argv.slice(1), { ...options, maxBuffer: 4 * 1024 * 1024, timeout: 300_000 })
}

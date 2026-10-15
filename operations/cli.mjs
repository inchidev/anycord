#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, open, rm } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { operationClient, executeJob, restoreBackup, verifyBackup, installationOrigin, downloadS3Backup } from './core.mjs'
import { activateRelease } from './activate.mjs'
const [command, configFile, extra] = process.argv.slice(2)
assert(['run', 'once', 'backup', 'restore', 'resume', 'rollback', 'verify', 'download'].includes(command), 'Usage: node operations/cli.mjs <run|once|backup|restore|resume|rollback|verify|download> /private/operations.json [backup-path|job-id|backup-id]')
const configPath = resolve(configFile || ''), config = JSON.parse(await readFile(configPath, 'utf8'))
config.origin = installationOrigin(config.origin)
assert(['cloudflare', 'celld'].includes(config.engine)); assert(config.backupDirectory && config.releaseDirectory)
config.backupDirectory = resolve(config.backupDirectory); config.releaseDirectory = resolve(config.releaseDirectory)
assert(config.backupDirectory !== config.releaseDirectory && !config.backupDirectory.startsWith(config.releaseDirectory + '/'), 'Keep recovery copies outside release directories')
if (config.stateDirectory) assert(!config.backupDirectory.startsWith(resolve(config.stateDirectory) + '/') && config.backupDirectory !== resolve(config.stateDirectory), 'Keep recovery copies outside application state')
await mkdir(config.releaseDirectory, { recursive: true, mode: 0o700 })
const identityPath = join(config.releaseDirectory, 'runner-id')
let runnerId
try { runnerId = config.runnerId || (await readFile(identityPath, 'utf8')).trim() } catch { runnerId = randomUUID(); await writeFile(identityPath, runnerId, { mode: 0o600, flag: 'wx' }) }
const lockPath = join(config.releaseDirectory, 'runner.lock'); let lock
try { lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid, origin: config.origin, runnerId })) }
catch { throw new Error('Another runner or a stale lock exists. Stop the old process and inspect runner.lock before recovery.') }
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true })
const client = operationClient(config)
async function runClaim(claim) {
  if (!claim.job) return false
  const { job, key } = claim
  assert(job.kind !== 'restore', 'Resume restores with the restore command and its backup path')
  const journal = join(config.releaseDirectory, job.id + '.json')
  await writeFile(journal, JSON.stringify({ id: job.id, kind: job.kind, key, runnerId, origin: config.origin }) + '\n', { mode: 0o600 })
  console.log(`Running ${job.kind} ${job.id}`)
  const timer = setInterval(() => { void client('/heartbeat', { method: 'POST', body: {} }).catch(() => {}) }, 30_000)
  try { await executeJob(client, job, key, config, { activate: activateRelease }); console.log(`Completed ${job.kind} ${job.id}`) }
  finally { clearInterval(timer) }
  return true
}
try {
  if (command === 'download') { assert(config.s3 && extra, 'Configure the independent backup S3 destination and pass a backup UUID'); const backup=await downloadS3Backup(config.s3,extra,config.backupDirectory);console.log(`Downloaded and verified encrypted S3 backup ${backup.manifest.id}`) }
  else if (command === 'verify') { assert(extra, 'Pass a backup directory'); const { manifest } = await verifyBackup(resolve(extra)); console.log(`Verified backup ${manifest.id}: ${manifest.tables.length} tables, ${manifest.objects.length} objects`) }
  else if (command === 'restore') {
    assert(extra, 'Pass a verified backup directory; destination must be empty')
    const timer = setInterval(() => { void client('/heartbeat', { method: 'POST', body: {} }).catch(() => {}) }, 30_000)
    try { const result = await restoreBackup(client, resolve(extra), runnerId, { resumeId: process.env.ANYCORD_RESTORE_RESUME_ID }); console.log(`Restored ${result.id}; sessions revoked and external integrations disabled`) }
    finally { clearInterval(timer) }
  } else {
    if (command === 'backup') await client('/enqueue', { method: 'POST', body: { id: randomUUID(), kind: 'backup' } })
    if (command === 'resume' || command === 'rollback') {
      assert(extra, 'Pass the interrupted job ID after stopping the previous runner')
      if (command === 'rollback') {
        const status = await client('/status'), job = status.jobs.find(j => j.id === extra)
        assert(job?.kind === 'update' && job.checkpoint && job.status !== 'complete', 'Choose an interrupted update with its verified recovery point')
        const backup = await verifyBackup(join(config.backupDirectory, job.checkpoint))
        assert.equal(backup.manifestHash, job.result?.manifestHash)
        assert.equal(backup.manifest.build.schema, status.build.schema, 'Code rollback cannot undo schema changes; use a separate restore destination')
        const claim = await client('/claim', { method: 'POST', body: { runnerId, resumeId: extra } })
        const retargeted = await client(`/jobs/${extra}/rollback`, { method: 'POST', key: claim.key, body: { sourceBuild: backup.manifest.build, backupId: backup.manifest.id, manifestHash: backup.manifestHash } })
        await runClaim({ job: retargeted, key: claim.key })
      } else { const status=await client('/status');const job=status.jobs.find(j=>j.id===extra);assert(job,'Update job not found');if(job.status==='complete')console.log('Update already completed');else await runClaim(await client('/claim', { method: 'POST', body: { runnerId, resumeId: extra } })) }
    }
    else do { await client('/heartbeat', { method: 'POST', body: {} }); await runClaim(await client('/claim', { method: 'POST', body: { runnerId } })); if (command !== 'run') break; await delay(5000) } while (!stopping)
  }
} catch (error) {
  const path = join(config.releaseDirectory, 'last-error.log')
  const entries = []; for (let current = error; current; current = current.cause) entries.push(current.stack || current.message)
  let text = entries.join('\nCaused by:\n')
  for (const [key, value] of Object.entries(process.env)) if (/SECRET|TOKEN|PASSWORD|ACCESS_KEY/.test(key) && value) text = text.replaceAll(value, '<REDACTED>')
  await writeFile(path, text + '\n', { mode: 0o600 }); console.error(`Operation failed. Inspect the private runner log ${path}. A failed update/restore remains in maintenance until explicit recovery.`); process.exitCode = 1
} finally { await lock.close(); await rm(lockPath) }

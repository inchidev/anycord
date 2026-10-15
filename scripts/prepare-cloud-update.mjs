import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const installation = JSON.parse(await readFile('installation.json','utf8'))
const { UPDATE_JOB_ID: id, UPDATE_INSTALLATION_ID: installationId, UPDATE_ORIGIN: origin, UPDATE_VERSION: version, ANYCORD_MIGRATION_TOKEN: token, CLOUDFLARE_API_TOKEN: cloudflareToken } = process.env
assert(origin === installation.origin && /^https:\/\//.test(origin),'Update origin differs from this repository’s configured installation')
assert(/^[a-f0-9-]{36}$/.test(id || '') && /^[a-f0-9-]+$/.test(installationId || ''),'Invalid update identity')
assert(/^\d+\.\d+\.\d+$/.test(version || '') && token && cloudflareToken,'Missing version or production credentials')
const response = await fetch(origin+'/api/_operations/status',{headers:{'X-Migration-Token':token},redirect:'error',signal:AbortSignal.timeout(20_000)})
assert(response.ok,'Cannot inspect the configured installation')
const status = await response.json(),job=status.jobs.find(j=>j.id===id)
assert.equal(status.installationId,installationId,'Installation identity differs')
assert(job?.kind==='update' && job.targetVersion===version && job.checkpoint && job.result?.manifestHash,'Update has no approved version and verified S3 checkpoint')
assert(['running','failed','complete'].includes(job.status),'Update is not ready for deployment')
assert(job.status==='complete' || status.maintenance,'The update snapshot is no longer frozen; request a fresh update')
assert.equal(status.engine,'cloudflare','This example workflow targets Cloudflare; configure a custom executor for a remote celld host')
await mkdir('output/cloud-update',{recursive:true,mode:0o700})
await writeFile('output/cloud-update/source.json',JSON.stringify(status.build)+'\n',{mode:0o600})
await writeFile('output/cloud-update/operator.json',JSON.stringify({origin,engine:status.engine,runnerId:id,backupMode:'installation-s3',migrationTokenEnv:'ANYCORD_MIGRATION_TOKEN',backupDirectory:resolve('output/cloud-update/recovery'),releaseDirectory:resolve('output/cloud-update/releases'),cloudflare:{installationFile:resolve('installation.json'),wrangler:resolve('node_modules/.bin/wrangler'),tokenEnv:'CLOUDFLARE_API_TOKEN'}},null,2)+'\n',{mode:0o600})
console.log('Approved installation, target version and S3 recovery point verified. Deployment credentials remain in the production environment.')

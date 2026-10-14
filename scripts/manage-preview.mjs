import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFile, lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { accountId, authorize, githubClient, previewConfig, previewIdentity, previewSecrets, productionDatabase, repository, validatePull } from './preview-policy.mjs'
import { waitForPreview } from './verify-preview.mjs'

const operation = process.env.PREVIEW_OPERATION
assert(['deploy', 'destroy'].includes(operation))
assert.equal(process.env.GITHUB_REPOSITORY, repository)
assert.equal(process.env.GITHUB_REF, 'refs/heads/main')
const identity = previewIdentity(process.env.PREVIEW_PR)
const { pr, name, bucket, origin } = identity
const github = githubClient()
const checkAuthorization = async () => {
  if (process.env.GITHUB_EVENT_NAME === 'pull_request_target') {
    assert.equal(operation, 'destroy')
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    assert.equal(event.action, 'closed'); assert.equal(event.pull_request.number, pr)
    validatePull(await github(`/repos/${repository}/pulls/${pr}`), pr, null, { closed: true })
  } else {
    assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch')
    const pull = await github(`/repos/${repository}/pulls/${pr}`)
    await authorize(github, { actor: process.env.GITHUB_ACTOR, triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR,
      pr, sha: process.env.PREVIEW_SHA, closed: operation === 'destroy' && pull.state === 'closed' })
  }
}
// Repeat the policy check on this fresh runner immediately before credentials are used.
await checkAuthorization()
const token = process.env.CLOUDFLARE_API_TOKEN
assert(token, 'Configure preview environment CLOUDFLARE_API_TOKEN')
const prefix = `/accounts/${accountId}`
async function cloudflare(path, { method = 'GET', body, missing = false } = {}) {
  assert(path.startsWith(prefix + '/'))
  const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (missing && response.status === 404) return null
  const result = await response.json()
  // Do not log provider bodies: requests may involve credentials or untrusted code.
  assert(response.ok && result.success, `Cloudflare ${method} failed (${response.status}; codes ${(result.errors || []).map(e => e.code).join(',')})`)
  return result
}
const database = async () => {
  const result = await cloudflare(`${prefix}/d1/database?name=${name}&per_page=100`)
  const matches = result.result.filter(db => db.name === name)
  assert(matches.length <= 1, 'Ambiguous preview database')
  const db = matches[0]
  if (db) assert(db.uuid !== productionDatabase && /^[a-f0-9-]{36}$/.test(db.uuid), 'Refusing production/invalid D1 ID')
  return db
}

if (operation === 'destroy') {
  // Stop writes and remove the preview's DO namespaces before deleting its data.
  await cloudflare(`${prefix}/workers/scripts/${name}?force=true`, { method: 'DELETE', missing: true })
  const existingBucket = await cloudflare(`${prefix}/r2/buckets/${bucket}`, { missing: true })
  if (existingBucket) {
    let empty = false
    for (let page = 0; page < 1000; page++) {
      const objects = await cloudflare(`${prefix}/r2/buckets/${bucket}/objects?per_page=1000`)
      if (!objects.result.length) { empty = true; break }
      await cloudflare(`${prefix}/r2/buckets/${bucket}/objects`, { method: 'DELETE', body: objects.result.map(o => o.key) })
    }
    assert(empty, 'Bucket cleanup did not finish; rerun destroy')
    await cloudflare(`${prefix}/r2/buckets/${bucket}`, { method: 'DELETE' })
  }
  const db = await database()
  if (db) await cloudflare(`${prefix}/d1/database/${db.uuid}`, { method: 'DELETE' })
  const pull = await github(`/repos/${repository}/pulls/${pr}`)
  await github(`/repos/${repository}/check-runs`, { method: 'POST', body: {
    name: 'PR preview', head_sha: pull.head.sha, status: 'completed', conclusion: 'neutral',
    output: { title: `Preview PR #${pr} removed`, summary: 'The isolated Worker, Durable Objects, D1 database and R2 bucket have been removed.' },
  } })
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `Removed preview PR #${pr}: Worker, Durable Objects, D1 and private R2 bucket.\n`)
  console.log(`Removed preview PR #${pr}`)
} else {
  const artifact = resolve('preview-bundle')
  assert.deepEqual((await readdir(artifact)).sort(), ['public', 'worker.js'])
  let files = 0, size = 0
  async function inspect(path) {
    const stat = await lstat(path)
    assert(!stat.isSymbolicLink(), 'Artifact symlinks are forbidden')
    if (stat.isDirectory()) { for (const entry of await readdir(path)) await inspect(join(path, entry)); return }
    assert(stat.isFile()); size += stat.size; files++
    assert(size <= 100 * 1024 * 1024 && files <= 10_000, 'Artifact size/file limit exceeded')
  }
  await inspect(artifact)
  const expected = JSON.parse(await readFile(join(artifact, 'public/version.json'), 'utf8'))
  assert.equal(expected.commit, process.env.PREVIEW_SHA)
  assert.equal(expected.apiVersion, 1)
  assert(/^\d+\.\d+\.\d+$/.test(expected.version) && /^\d{4}_[a-z_]+$/.test(expected.schema))
  const subdomain = await cloudflare(`${prefix}/workers/subdomain`)
  assert.equal(subdomain.result.subdomain, 'ij69', 'Unexpected workers.dev subdomain')
  let db = await database()
  if (!db) db = (await cloudflare(`${prefix}/d1/database`, { method: 'POST', body: { name, primary_location_hint: 'apac' } })).result
  if (!await cloudflare(`${prefix}/r2/buckets/${bucket}`, { missing: true })) {
    await cloudflare(`${prefix}/r2/buckets`, { method: 'POST', body: { name: bucket, locationHint: 'apac' } })
  }
  const config = previewConfig(pr, db.uuid)
  const configPath = join(artifact, 'wrangler.jsonc')
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
  const secrets = previewSecrets(process.env.PREVIEW_SECRET_SEED, pr)
  for (const value of Object.values(secrets)) console.log(`::add-mask::${value}`)
  const secretPath = resolve(process.env.RUNNER_TEMP, 'preview-secrets.json')
  await writeFile(secretPath, JSON.stringify(secrets), { mode: 0o600 })
  await checkAuthorization()
  const deploy = spawnSync(resolve('node_modules/.bin/wrangler'), ['deploy', '--config', configPath, '--secrets-file', secretPath], {
    stdio: 'inherit', timeout: 5 * 60_000,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
  })
  assert.equal(deploy.status, 0, 'Preview deployment failed')
  // Secret-bearing HTTP calls are restricted to the constructed preview origin,
  // with redirects forbidden. A PR cannot redirect migration credentials elsewhere.
  let healthy = false
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const migration = await fetch(origin + '/api/_migrate', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json', 'X-Migration-Token': secrets.MIGRATION_TOKEN }, body: '{}',
      })
      if (migration.ok) {
        const health = await (await fetch(origin + '/api/health', { redirect: 'error', signal: AbortSignal.timeout(15_000) })).json()
        if (health.ok && health.schema === expected.schema && health.build?.commit === expected.commit) { healthy = true; break }
      }
    } catch {}
    await delay(2000)
  }
  assert(healthy, 'Preview migration/health check failed')
  await waitForPreview(origin, expected)
  await checkAuthorization()
  await appendFile(process.env.GITHUB_OUTPUT, `url=${origin}\n`)
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `Preview PR #${pr}: [Open preview](${origin})\n\nSource: \`${expected.commit}\`\n\nIsolated Worker/D1/R2/DO; schema \`${expected.schema}\`. First-account setup code is derived from the private preview seed; it is never published in logs. See docs/previews.md.\n`)
  await github(`/repos/${repository}/check-runs`, { method: 'POST', body: {
    name: 'PR preview', head_sha: expected.commit, status: 'completed', conclusion: 'success', details_url: origin,
    output: { title: `Preview PR #${pr} ready`, summary: `[Open preview](${origin})\n\nTested source: \`${expected.commit}\`. Exact API/client identity, migration schema \`${expected.schema}\` and PWA routes verified. Separate Worker/D1/R2/DO; no production bindings. Real provider acceptance remains a separate test.` },
  } })
  console.log(`PASS preview PR #${pr} at ${expected.commit}: ${origin}`)
}

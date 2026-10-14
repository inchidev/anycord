import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'

export const repository = 'inchidev/anycord'
export const accountId = 'ee47884b4794b0240647bfa7a3e56c0b'
export const productionDatabase = 'bdcc0b49-ee61-44cc-a56c-b51ec98b93c1'
export function previewIdentity(pr) {
  assert(/^[1-9][0-9]{0,8}$/.test(String(pr)), 'Invalid PR number')
  const name = `anycord-pr-${pr}`
  return { pr: Number(pr), name, bucket: `${name}-files`, origin: `https://${name}.ij69.workers.dev` }
}
export function requireMaintainer(role) {
  // GitHub's legacy `permission` maps Maintain to Write. Check role_name instead.
  assert(['maintain', 'admin'].includes(role), 'Only Maintain/Admin may launch or rerun previews')
}
export function validatePull(pull, pr, sha, { closed = false } = {}) {
  previewIdentity(pr)
  assert.equal(pull.number, Number(pr))
  assert.equal(pull.base.repo.full_name, repository)
  assert.equal(pull.base.ref, 'main', 'Preview target must be main')
  assert.equal(pull.state, closed ? 'closed' : 'open', 'PR state changed')
  if (!closed) {
    assert(/^[a-f0-9]{40}$/.test(sha || ''), 'Provide the exact reviewed head SHA')
    assert.equal(pull.head.sha, sha, 'PR head changed; review it and launch again with the new SHA')
  }
}
export function previewSecrets(seed, pr) {
  previewIdentity(pr)
  assert(typeof seed === 'string' && seed.length >= 64, 'Preview secret seed is missing')
  return Object.fromEntries(['APP_SECRET', 'MIGRATION_TOKEN', 'SETUP_TOKEN'].map(key => [key,
    createHmac('sha256', seed).update(`anycord-preview:${pr}:${key}`).digest('hex')]))
}
export function previewConfig(pr, databaseId) {
  const { name, bucket, origin } = previewIdentity(pr)
  assert(/^[a-f0-9-]{36}$/.test(databaseId) && databaseId !== productionDatabase, 'Refusing production/invalid D1 binding')
  // Construct an allowlist from trusted main. Never spread a PR's Wrangler config.
  return {
    name, account_id: accountId, main: 'worker.js', no_bundle: true,
    find_additional_modules: false, compatibility_date: '2026-10-14', compatibility_flags: ['nodejs_compat'],
    workers_dev: true, preview_urls: false,
    assets: { directory: './public', binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api/*'] },
    durable_objects: { bindings: [{ name: 'ROOMS', class_name: 'ChatRoom' }, { name: 'HUBS', class_name: 'WorkspaceHub' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['ChatRoom'] }, { tag: 'v2', new_sqlite_classes: ['WorkspaceHub'] }],
    d1_databases: [{ binding: 'DB', database_name: name, database_id: databaseId }],
    r2_buckets: [{ binding: 'FILES', bucket_name: bucket }],
    vars: { AUTH_BASE_URL: origin, STORAGE_ENDPOINT: '', STORAGE_BUCKET: '', STORAGE_REGION: 'auto' },
    limits: { cpu_ms: 1000 },
    observability: { enabled: true, head_sampling_rate: 1, logs: { invocation_logs: false }, redact_query_string: true },
    // Preview callbacks/retries are useful for #16, but only with preview-owned credentials.
    triggers: { crons: ['* * * * *'] },
  }
}

export function githubClient(token = process.env.GH_TOKEN) {
  assert(token, 'GitHub token is required')
  return async (path, { method = 'GET', body } = {}) => {
    assert(path.startsWith(`/repos/${repository}/`), 'Unexpected GitHub repository')
    const response = await fetch(`https://api.github.com${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assert(response.ok, `GitHub request failed (${response.status})`)
    return response.status === 204 ? null : response.json()
  }
}
export async function authorize(github, { actor, triggeringActor, pr, sha, closed = false }) {
  // Re-check both actors on every run, including a rerun initiated by someone else.
  for (const login of new Set([actor, triggeringActor])) {
    assert(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(login || ''), 'Invalid actor')
    const role = await github(`/repos/${repository}/collaborators/${login}/permission`)
    requireMaintainer(role.role_name)
  }
  const pull = await github(`/repos/${repository}/pulls/${previewIdentity(pr).pr}`)
  validatePull(pull, pr, sha, { closed })
  return pull
}

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorize, previewConfig, previewIdentity, previewSecrets, productionDatabase, repository, requireMaintainer, validatePull } from './preview-policy.mjs'
import { waitForPreview } from './verify-preview.mjs'

const sha = 'a'.repeat(40)
const pull = { number: 16, state: 'open', base: { ref: 'main', repo: { full_name: repository } }, head: { sha } }
test('only Maintain/Admin can authorize; legacy Write is never treated as Maintain', () => {
  for (const role of ['maintain', 'admin']) requireMaintainer(role)
  for (const role of ['write', 'triage', 'read', 'none', undefined, 'custom', 'Admin']) assert.throws(() => requireMaintainer(role))
})
test('manual dispatch and rerun actors are both checked, including revoked access', async () => {
  const mock = roles => async path => path.endsWith('/pulls/16') ? pull : { role_name: roles[path.split('/').at(-2)] }
  const context = { actor: 'owner', triggeringActor: 'other', pr: '16', sha }
  await authorize(mock({ owner: 'admin', other: 'maintain' }), context)
  await assert.rejects(authorize(mock({ owner: 'admin', other: 'write' }), context))
  await assert.rejects(authorize(mock({ owner: 'read', other: 'admin' }), context))
})
test('preview names are derived from strict PR numbers; production names cannot be injected', () => {
  assert.deepEqual(previewIdentity(16), { pr: 16, name: 'anycord-pr-16', bucket: 'anycord-pr-16-files', origin: 'https://anycord-pr-16.ij69.workers.dev' })
  for (const pr of ['0', '-1', '01', '16\n', '../anycord', '16;anything', 'anycord', '1000000000']) assert.throws(() => previewIdentity(pr))
})
test('PR identity/state/base/head changes fail closed', () => {
  validatePull(pull, 16, sha)
  for (const changed of [
    { ...pull, number: 17 }, { ...pull, state: 'closed' },
    { ...pull, base: { ...pull.base, ref: 'production' } },
    { ...pull, base: { ...pull.base, repo: { full_name: 'other/repo' } } },
    { ...pull, head: { sha: 'b'.repeat(40) } },
  ]) assert.throws(() => validatePull(changed, 16, sha))
  assert.throws(() => validatePull(pull, 16, 'main'))
  assert.throws(() => validatePull(pull, 16, sha, { closed: true }))
  validatePull({ ...pull, state: 'closed' }, 16, null, { closed: true })
})
test('deployment allowlist cannot use production D1/routes or external DO/service bindings', () => {
  const config = previewConfig(16, '11111111-1111-4111-8111-111111111111')
  assert.equal(config.name, 'anycord-pr-16')
  assert.equal(config.r2_buckets[0].bucket_name, 'anycord-pr-16-files')
  assert.equal(config.vars.AUTH_BASE_URL, previewIdentity(16).origin)
  for (const forbidden of ['routes', 'services', 'env', 'kv_namespaces', 'unsafe', 'build', 'containers', 'workflows', 'secrets_store_secrets']) assert.equal(config[forbidden], undefined)
  assert(config.durable_objects.bindings.every(b => !b.script_name && !b.namespace_id))
  assert.equal(config.find_additional_modules, false)
  assert.throws(() => previewConfig(16, productionDatabase))
  assert.throws(() => previewConfig(16, 'invalid'))
})
test('preview credentials are stable per PR, separate across purposes/PRs, with no production input', () => {
  const seed = '1'.repeat(64)
  const one = previewSecrets(seed, 16)
  assert.deepEqual(one, previewSecrets(seed, 16))
  assert.equal(new Set(Object.values(one)).size, 3)
  assert(Object.values(one).every(v => /^[a-f0-9]{64}$/.test(v)))
  assert.notDeepEqual(one, previewSecrets(seed, 17))
  assert.throws(() => previewSecrets('', 16))
})
test('deployment waits for static assets even when the exact Worker is healthy', async () => {
  const expected = { version: '0.3.0', commit: sha, apiVersion: 1, schema: '0007_cultured_toad_men' }
  let rounds = 0
  const request = async url => {
    const path = new URL(url).pathname
    if (path === '/api/health') { rounds++; return Response.json({ ok: true, schema: expected.schema, build: expected }) }
    if (path === '/api/runtime') return Response.json({ engine: 'cloudflare', apiVersion: 1, build: expected })
    if (path === '/version.json') return Response.json(expected)
    if (path === '/manifest.webmanifest' && rounds === 1) return new Response('Propagating', { status: 503 })
    return new Response('Ready')
  }
  await waitForPreview(previewIdentity(16).origin, expected, { request, sleep: async () => {}, attempts: 2 })
  assert.equal(rounds, 2)
})
test('mixed client/Worker versions never pass preview readiness', async () => {
  const expected = { version: '0.3.0', commit: sha, apiVersion: 1, schema: '0007_cultured_toad_men' }
  const request = async url => {
    const path = new URL(url).pathname
    if (path === '/api/health') return Response.json({ ok: true, schema: expected.schema, build: expected })
    if (path === '/api/runtime') return Response.json({ engine: 'cloudflare', apiVersion: 1, build: expected })
    if (path === '/version.json') return Response.json({ ...expected, commit: 'b'.repeat(40) })
    return new Response('Ready')
  }
  await assert.rejects(waitForPreview(previewIdentity(16).origin, expected, { request, sleep: async () => {}, attempts: 2 }), /did not become ready/)
})

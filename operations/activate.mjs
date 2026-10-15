import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runCommand } from './core.mjs'

function bindingIdentity(binding) {
  const base = { name: binding.name, type: binding.type }
  if (binding.type === 'd1') return { ...base, id: binding.database_id || binding.id }
  if (binding.type === 'r2_bucket') return { ...base, bucket: binding.bucket_name }
  if (binding.type === 'durable_object_namespace') return { ...base, namespace: binding.namespace_id, class: binding.class_name }
  if (binding.type === 'plain_text') return { ...base, text: binding.text }
  if (binding.type === 'secret_text') return base
  throw new Error(`Preserve the unsupported binding ${binding.name} with a reviewed custom deployment adapter`)
}
export async function activateCloudflare(release, config, { transport = fetch, run = runCommand } = {}) {
  const options = config.cloudflare; assert(options?.installationFile && options?.wrangler, 'Configure Cloudflare installationFile and the pinned Wrangler executable')
  const installation = JSON.parse(await readFile(options.installationFile, 'utf8'))
  assert.equal(installation.origin, config.origin)
  assert(/^[a-f0-9]{32}$/.test(installation.accountId) && /^[a-z0-9][a-z0-9_-]*$/.test(installation.workerName))
  const token = process.env[options.tokenEnv || 'CLOUDFLARE_API_TOKEN']; assert(token, 'Cloudflare deployment token is missing on the operator machine')
  async function accountGet(path) { const response = await transport(`https://api.cloudflare.com/client/v4/accounts/${installation.accountId}/workers/${path}`, { headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(30_000) }); assert(response.ok, 'Cannot inspect existing Cloudflare installation'); const data = await response.json(); assert(data.success); return data.result }
  async function settings() { return (await accountGet(`scripts/${installation.workerName}/settings`)).bindings }
  const hostname = new URL(config.origin).hostname
  const workerDomain = await accountGet(`scripts/${installation.workerName}/subdomain`)
  const domains = await accountGet(`domains?service=${encodeURIComponent(installation.workerName)}`)
  assert(domains.every(d => d.service === installation.workerName && d.enabled !== false && !d.previews_enabled), 'Disabled or preview domain routing requires a reviewed deployment adapter')
  if (hostname.endsWith('.workers.dev')) {
    const account = await accountGet('subdomain')
    assert(workerDomain.enabled && hostname === `${installation.workerName}.${account.subdomain}.workers.dev`, 'Origin does not belong to the configured Worker')
  } else {
    assert(domains.some(d => d.hostname === hostname && d.service === installation.workerName && d.enabled !== false), 'Origin is not an active custom domain of the configured Worker')
    assert(installation.customDomain === true, 'Preserve the existing custom domain in installation.json')
  }
  const before = await settings()
  assert.equal(before.find(b => b.name === 'DB')?.database_id || before.find(b => b.name === 'DB')?.id, installation.databaseId, 'Configured database differs from the existing installation')
  assert.equal(before.find(b => b.name === 'FILES')?.bucket_name, installation.bucketName, 'Configured file bucket differs from the existing installation')
  await run([process.execPath, 'configure.mjs', resolve(options.installationFile)], { cwd: release.directory })
  const path = join(release.directory, 'wrangler.jsonc'), candidate = JSON.parse(await readFile(path, 'utf8'))
  candidate.workers_dev = workerDomain.enabled; candidate.preview_urls = workerDomain.previews_enabled
  candidate.routes = domains.map(d => ({ pattern: d.hostname, custom_domain: true }))
  const supportedNames = new Set([...candidate.d1_databases.map(b => b.binding), ...candidate.r2_buckets.map(b => b.binding), ...candidate.durable_objects.bindings.map(b => b.name)])
  for (const binding of before) {
    bindingIdentity(binding)
    if (binding.type === 'plain_text') { if (binding.name === 'AUTH_BASE_URL') assert.equal(binding.text, config.origin); candidate.vars[binding.name] = binding.text }
    else if (binding.type !== 'secret_text') assert(supportedNames.has(binding.name), 'New release would remove an existing resource binding')
  }
  await writeFile(path, JSON.stringify(candidate, null, 2) + '\n', { mode: 0o600 })
  await run([options.wrangler, 'deploy', '--config', path], { cwd: release.directory, env: { ...process.env, CLOUDFLARE_API_TOKEN: token } })
  const after = await settings()
  for (const binding of before) assert(JSON.stringify(bindingIdentity(after.find(b => b.name === binding.name) || {})) === JSON.stringify(bindingIdentity(binding)), 'Deployment changed an existing binding or runtime variable')
  const afterDomains = await accountGet(`domains?service=${encodeURIComponent(installation.workerName)}`)
  assert.deepEqual(afterDomains.map(d => d.hostname).sort(), domains.map(d => d.hostname).sort(), 'Deployment changed existing custom domains')
}
function dockerPrefix(config) { return ['docker', ...(config.context ? ['--context', config.context] : [])] }
export async function activateCelld(release, config, { run = runCommand } = {}) {
  const options = config.celld
  assert(options?.composeFile && options?.project && options?.service, 'Configure the existing celld Compose file, project and service')
  const docker = dockerPrefix(options), compose = [...docker, 'compose', ...(options.envFile ? ['--env-file', options.envFile] : []), '-f', options.composeFile, '-p', options.project]
  const id = (await run([...compose, 'ps', '-q', options.service])).stdout.trim(); assert(id && !id.includes('\n'), 'Exactly one running celld container is required')
  const before = JSON.parse((await run([...docker, 'inspect', id])).stdout)[0]
  const mount = before.Mounts.find(m => m.Destination === '/app/.celld'); assert(mount, 'Existing persistent celld state mount is missing')
  const image = `anycord:${release.manifest.version}-${release.manifest.commit.slice(0, 12)}`
  const env = { ...process.env, ANYCORD_IMAGE: image }
  const resolved = JSON.parse((await run([...compose, 'config', '--format', 'json'], { env })).stdout)
  const service = resolved.services[options.service]; assert.equal(service.image, image, 'Compose must use ${ANYCORD_IMAGE} for the chat image')
  assert.equal(service.environment.AUTH_BASE_URL, config.origin, 'Compose would change the auth origin')
  const nextMount = service.volumes.find(v => v.target === '/app/.celld'); assert(nextMount, 'Compose would remove persistent state')
  if (nextMount.type === 'volume') assert.equal(resolved.volumes[nextMount.source].name, mount.Name, 'Compose would replace the state volume')
  else assert.equal(resolve(nextMount.source), mount.Source, 'Compose would replace the state directory')
  const oldEnv = Object.fromEntries(before.Config.Env.map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)] }))
  for (const key of ['STORAGE_ENDPOINT', 'STORAGE_BUCKET', 'STORAGE_REGION', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY']) assert(String(service.environment[key] || '') === (oldEnv[key] || ''), `Compose would change ${key}`)
  await run([...docker, 'build', '-t', image, release.directory])
  await run([...compose, 'up', '-d', '--no-build', options.service], { env })
  const nextId = (await run([...compose, 'ps', '-q', options.service], { env })).stdout.trim()
  const after = JSON.parse((await run([...docker, 'inspect', nextId])).stdout)[0]
  assert.equal(after.Config.Image, image)
  const actual = after.Mounts.find(m => m.Destination === '/app/.celld')
  assert.equal(actual?.Source, mount.Source); assert.equal(actual?.Name, mount.Name)
}
export async function activateRelease(release, config) {
  if (config.engine === 'cloudflare') return activateCloudflare(release, config)
  if (config.engine === 'celld') return activateCelld(release, config)
  throw new Error('Unsupported activation engine')
}

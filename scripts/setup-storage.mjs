import { readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { AwsClient } from 'aws4fetch'
const path = process.env.STORAGE_ENV_FILE || '.env.storage'
let values
try { values = await readFile(path, 'utf8') } catch {
  values = `RUSTFS_ACCESS_KEY=anycord${randomBytes(8).toString('hex')}\nRUSTFS_SECRET_KEY=${randomBytes(32).toString('hex')}\n`
  await writeFile(path, values, { mode: 0o600 })
}
const env = Object.fromEntries(values.trim().split('\n').map(line => line.split('=')))
const args = [...(process.env.DOCKER_CONTEXT ? ['--context', process.env.DOCKER_CONTEXT] : []), 'compose', '--env-file', path, '-f', 'compose.yml', '-f', 'compose.rustfs.yml', 'up', '-d', 'rustfs']
if (spawnSync('docker', args, { stdio: 'inherit' }).status) process.exit(1)
const endpoint = 'http://127.0.0.1:9000'
let healthy = false
for (let i = 0; i < 120; i++) { try { if ((await fetch(endpoint + '/health')).ok) { healthy = true; break } } catch {} await delay(500) }
if (!healthy) throw new Error('RustFS did not become healthy')
const client = new AwsClient({ accessKeyId: env.RUSTFS_ACCESS_KEY, secretAccessKey: env.RUSTFS_SECRET_KEY, region: 'us-east-1', service: 's3' })
const response = await client.fetch(endpoint + '/anycord-files', { method: 'PUT' })
if (!response.ok && response.status !== 409) throw new Error(`Bucket setup failed (${response.status})`)
console.log('Private anycord-files bucket ready. Credentials are stored in ' + path)

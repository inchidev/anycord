import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
// Run inside an extracted release. Installation config contains IDs, never secrets.
const path = process.argv[2]
assert(path, 'Usage: node configure.mjs /path/to/installation.json')
const installation = JSON.parse(await readFile(path, 'utf8'))
for (const key of ['accountId', 'workerName', 'databaseId', 'databaseName', 'bucketName', 'origin']) assert(typeof installation[key] === 'string' && installation[key], `Missing ${key}`)
assert(/^[a-f0-9]{32}$/.test(installation.accountId), 'Invalid account ID')
assert(/^[a-z0-9][a-z0-9_-]*$/.test(installation.workerName), 'Invalid Worker name')
assert(/^[a-f0-9-]{36}$/.test(installation.databaseId), 'Invalid D1 ID')
assert(new URL(installation.origin).origin === installation.origin && installation.origin.startsWith('https://'), 'Origin must be an HTTPS origin')
const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'))
config.account_id = installation.accountId; config.name = installation.workerName
config.d1_databases[0].database_id = installation.databaseId; config.d1_databases[0].database_name = installation.databaseName
config.r2_buckets[0].bucket_name = installation.bucketName; config.vars.AUTH_BASE_URL = installation.origin
if (installation.customDomain) config.routes = [{ pattern: new URL(installation.origin).hostname, custom_domain: true }]
await writeFile('wrangler.jsonc', JSON.stringify(config, null, 2) + '\n')
console.log('Configured release for', installation.workerName, installation.origin)

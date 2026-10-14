import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
const storage = Object.fromEntries((await readFile('.env.storage', 'utf8')).trim().split('\n').map(s => s.split('=')))
const env = { ...process.env, STORAGE_ENDPOINT: 'http://rustfs:9000', STORAGE_BUCKET: 'anycord-files', STORAGE_REGION: 'us-east-1', STORAGE_ACCESS_KEY_ID: storage.RUSTFS_ACCESS_KEY, STORAGE_SECRET_ACCESS_KEY: storage.RUSTFS_SECRET_KEY }
const args = ['--context', 'colima', 'run', '--rm', '--label', 'com.docker.compose.project=anycord-integration', '--label', 'com.docker.compose.service=integration', '--network', 'celld-local-chat_default']
for (const key of ['STORAGE_ENDPOINT', 'STORAGE_BUCKET', 'STORAGE_REGION', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY', 'TEST_ENGINE', 'TEST_WORKER_FILE']) if (env[key]) args.push('-e', key)
args.push('-v', `${process.cwd()}/scripts/integration.mjs:/app/scripts/integration.mjs:ro`)
args.push('celld-local-chat-chat:latest', 'node', 'scripts/integration.mjs')
const child = spawn('docker', args, { stdio: 'inherit', env })
child.on('exit', code => process.exit(code || 0))

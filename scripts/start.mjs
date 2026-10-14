import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
await mkdir('.celld', { recursive: true })
let secret
try { secret = await readFile('.celld/app-secret', 'utf8') } catch {
  secret = randomBytes(32).toString('hex')
  await writeFile('.celld/app-secret', secret, { mode: 0o600 })
}
const migrationToken = randomBytes(32).toString('hex')
await writeFile('.celld/migration-token', migrationToken, { mode: 0o600 })
await writeFile('.dev.vars', `APP_SECRET=${secret}\nMIGRATION_TOKEN=${migrationToken}\nAUTH_BASE_URL=${process.env.AUTH_BASE_URL || 'http://127.0.0.1:9876'}\n`, { mode: 0o600 })
let storageVars = ''
for (const key of ['STORAGE_ENDPOINT', 'STORAGE_BUCKET', 'STORAGE_REGION', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY']) if (process.env[key]) storageVars += `${key}=${JSON.stringify(process.env[key])}\n`
if (storageVars) await writeFile('.dev.vars', await readFile('.dev.vars', 'utf8') + storageVars, { mode: 0o600 })
const child = spawn('celld', ['dev', '.', '--host', '0.0.0.0', '--port', '9876', '--no-watch'], { stdio: 'inherit' })
// celld dev's controller uses Ctrl-C to stop its child node cleanly.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill('SIGINT'))
child.on('exit', (code) => process.exit(code ?? 1))
let ready = false
for (let i = 0; i < 160; i++) {
  try { if ((await fetch('http://127.0.0.1:9876/api/_runtime')).ok) { ready = true; break } } catch {}
  await delay(250)
}
if (!ready) { console.error('Runtime did not start'); child.kill('SIGTERM'); process.exitCode = 1 }
else {
  let legacy = []
  try { legacy = JSON.parse(await readFile('.celld/legacy-import.json', 'utf8')) } catch {}
  const response = await fetch('http://127.0.0.1:9876/api/_migrate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Migration-Token': migrationToken }, body: JSON.stringify({ legacy }) })
  if (!response.ok) { console.error(`Database migration failed (${response.status})`); child.kill('SIGTERM'); process.exitCode = 1 }
  else console.log('Database ready:', JSON.stringify(await response.json()))
}

setInterval(() => fetch('http://127.0.0.1:9876/api/_maintenance', { method: 'POST', headers: { 'X-Migration-Token': migrationToken } }).then(r => { if (!r.ok) console.warn('File cleanup failed') }).catch(() => {}), 3600_000).unref()

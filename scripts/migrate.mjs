import { readFile } from 'node:fs/promises'
const token = await readFile('.celld/migration-token', 'utf8')
const response = await fetch(`${process.env.CHAT_URL || 'http://127.0.0.1:9876'}/api/_migrate`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Migration-Token': token }, body: '{}',
})
if (!response.ok) throw new Error(`Migration failed (${response.status})`)
console.log(JSON.stringify(await response.json(), null, 2))

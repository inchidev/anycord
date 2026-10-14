import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import WebSocket from 'ws'
const { secrets } = JSON.parse(await readFile('.backups/deployment/qa.json','utf8'))
const base = 'https://anycord-qa.ij69.workers.dev', origin = 'http://localhost:19876'
async function request(path, { method='GET', body, token, headers={}, expected=200 }={}) {
  const r = await fetch(base+path,{method,headers:{...headers,...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:`Bearer ${token}`,Origin:origin}:{})},body:body===undefined?undefined:JSON.stringify(body)})
  const data = await r.json(); assert.equal(r.status,expected,JSON.stringify(data)); return {data,headers:r.headers}
}
await request('/api/_migrate',{method:'POST',headers:{'X-Migration-Token':secrets.MIGRATION_TOKEN},body:{}})
await request('/api/health')
const status = (await request('/api/auth/status')).data
if (!status.initialized) {
  await request('/api/auth/register',{method:'POST',body:{name:'qa_owner',password:'native-cloudflare-qa-password'},expected:403})
  await request('/api/auth/register',{method:'POST',body:{name:'qa_owner',password:'native-cloudflare-qa-password',setupCode:secrets.SETUP_TOKEN},expected:201})
}
const login = await request('/api/connections/login',{method:'POST',headers:{Origin:origin},body:{name:'qa_owner',password:'native-cloudflare-qa-password'}})
assert.equal(login.headers.get('Set-Cookie'),null)
const token = login.data.token
const bootstrap = (await request('/api/bootstrap',{token})).data; assert.equal(bootstrap.user.name,'qa_owner')
await request('/api/storage/test',{method:'POST',token})
assert.equal((await request('/api/storage',{token})).data.driver,'r2')
const ticket = (await request('/api/workspaces/main/live-ticket',{method:'POST',token})).data.ticket
const ws = new WebSocket(base.replace('http','ws')+'/api/workspaces/main/ws?ticket='+ticket,{headers:{Origin:origin}})
const events=[]; ws.on('message',bytes=>events.push(JSON.parse(bytes))); ws.on('error',()=>{})
await once(ws,'open')
const png = await readFile('/tmp/anycord-qa-pixel.png')
const attachment=(await request('/api/channels/general/attachments',{method:'POST',token,body:{name:'native-r2.png',size:png.length},expected:201})).data
const upload=await fetch(base+`/api/attachments/${attachment.id}/upload`,{method:'PUT',headers:{Authorization:`Bearer ${token}`,Origin:origin,'Content-Type':'application/octet-stream'},body:png})
assert.equal(upload.status,200,await upload.text())
const input={id:crypto.randomUUID(),text:'Native Cloudflare R2 check',attachmentIds:[attachment.id]}
const message=(await request('/api/channels/general/messages',{method:'POST',token,body:input,expected:201})).data
assert.equal(message.attachments[0].id,attachment.id)
await request('/api/channels/general/messages',{method:'POST',token,body:input})
const download=(await request(`/api/attachments/${attachment.id}/download`,{token})).data
assert.deepEqual(Buffer.from(await (await fetch(base+download.url)).arrayBuffer()),png)
await request(`/api/channels/general/messages/${message.id}`,{method:'PATCH',token,body:{text:'Native check edited'}})
await request(`/api/channels/general/messages/${message.id}`,{method:'POST',token,body:{emoji:'👍'}})
await request(`/api/channels/general/messages/${message.id}`,{method:'DELETE',token})
assert.equal((await fetch(base+download.url)).status,404)
await request(`/api/attachments/${attachment.id}`,{method:'DELETE',token})
assert(events.some(e=>e.type==='message'&&e.message.id===input.id),'native DO websocket message delivery')
ws.close()
await request('/api/auth/logout',{method:'POST',token})
await request('/api/bootstrap',{token,expected:401})
console.log('PASS: native Cloudflare D1 migration, setup gate, Better Auth, remote bearer/CORS, Durable Object WebSocket delivery, R2 upload/read/delete, idempotent message send, edit/reaction, deleted-file revocation and logout.')
await writeFile('output/cloudflare-qa.json',JSON.stringify({checkedAt:new Date().toISOString(),result:'pass',engine:'cloudflare',checks:['D1','Better Auth','CORS','Durable Object WebSocket','R2','attachments','logout']},null,2))

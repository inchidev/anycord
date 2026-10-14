import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {setTimeout as delay} from 'node:timers/promises'
const secrets=JSON.parse(await readFile('.backups/deployment/production-secrets.json','utf8'))
const base='https://anycord.inchi.dev'
const version=process.argv[2]
assert(version,'Pass the deployed Worker version ID')
const journal=JSON.parse(await readFile('drizzle/meta/_journal.json','utf8'))
let ready=false
for(let i=0;i<12;i++) {try {const r=await fetch(base+'/api/runtime');if(r.ok){ready=true;break}}catch{} await delay(5000)}
assert(ready,'Public domain must be reachable with valid HTTPS')
const migration=await fetch(base+'/api/_migrate',{method:'POST',headers:{'Content-Type':'application/json','X-Migration-Token':secrets.MIGRATION_TOKEN},body:'{}'})
assert.equal(migration.status,200,await migration.text())
const health=await(await fetch(base+'/api/health')).json();assert(health.ok);assert.equal(health.runtime,'cloudflare');assert.equal(health.schema,journal.entries.at(-1).tag)
const runtime=await(await fetch(base+'/api/runtime')).json();assert.equal(runtime.engine,'cloudflare')
const status=await(await fetch(base+'/api/auth/status')).json();if (!status.initialized) assert.equal(status.setupRequired,true)
if (!status.initialized) { const claim=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'unauthorized_claim_check',password:'test-only-do-not-create-account'})});assert.equal(claim.status,403) }
const html=await(await fetch(base)).text();assert.match(html,/_nuxt/);assert.match(html,/<title>Anycord/);assert.doesNotMatch(html,/Cellcord|favicon\.svg/)
for(const path of ['/login','/servers','/main/general']) {const response=await fetch(base+path);assert(response.ok,path);assert.match(await response.text(),/_nuxt/)}
for(const path of ['/favicon.png','/brand/anycord-symbol.png']) {const response=await fetch(base+path);assert(response.ok,path);assert.match(response.headers.get('Content-Type'),/image\/png/)}
const script=[...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)][0]?.[1];assert(script)
const asset=await fetch(new URL(script,base));assert.equal(asset.status,200);assert.match(asset.headers.get('Content-Type'),/javascript/)
if (!status.initialized) await writeFile('.backups/deployment/OPEN-ANYCORD.md',`# Set up Anycord\n\n[Open your private first-account setup link](${base}/login#setup=${secrets.SETUP_TOKEN})\n\nCreate your own username and password. The first account owns this installation. The setup code is filled automatically and removed from the address bar. Keep this link private until the first account is created.\n\nLocal celld data remains in its existing Docker volume. Cloudflare is an independent installation with a new database.\n`,{mode:0o600})
await writeFile('output/cloudflare-production.json',JSON.stringify({checkedAt:new Date().toISOString(),domain:base,health,runtime,initialized:status.initialized,setupRequired:status.setupRequired,checks:['HTTPS','native Workers assets','D1 migration 0005','runtime contract',status.initialized ? 'existing installation auth status' : 'first-owner setup gate','landing/login/server deep links','Anycord title/logo/favicon'],version},null,2))
console.log('PASS: https://anycord.inchi.dev, native assets, schema0005/health, Cloudflare runtime, landing/login/deep links, branding, and installation auth status. No production test account was created.')

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { operationClient, createBackup } from '../operations/core.mjs'
import { resolve, extname } from 'node:path'
import { createHmac } from 'node:crypto'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { chromium } from 'playwright'
// The generated client calls a disposable real Worker/D1 through a loopback
// server. Only the Telegram SDK and bot provider are replaced with local doubles.
const root = resolve('.output/public'), botToken = '12345:local-test-token-never-send-to-telegram'
const types = { '.js':'text/javascript', '.css':'text/css', '.html':'text/html', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml' }
let mf, browser
const backupDirectory = await mkdtemp(join(tmpdir(), 'anycord-browser-backups-'))
const buildInfo = JSON.parse(await readFile('shared/build-info.json', 'utf8'))
const versionParts = buildInfo.version.split('.').map(Number); versionParts[2]++
const nextRelease = { ...buildInfo, version: versionParts.join('.'), commit: '3'.repeat(40), format: 1, engines: ['cloudflare', 'celld'], artifacts: [] }
const server = createServer(async (req,res) => {
  try {
    if (req.url.startsWith('/api/')) {
      const chunks=[]; for await(const chunk of req)chunks.push(chunk)
      const result=await mf.dispatchFetch(base+req.url,{method:req.method,headers:req.headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})})
      const headers=Object.fromEntries(result.headers); if(result.headers.getSetCookie().length)headers['set-cookie']=result.headers.getSetCookie()
      res.writeHead(result.status,headers);res.end(Buffer.from(await result.arrayBuffer()));return
    }
    let path=resolve(root,'.'+new URL(req.url,'http://local').pathname);assert(path===root||path.startsWith(root+'/'))
    let bytes;try{bytes=await readFile(path)}catch{path=resolve(root,'app-shell.html');bytes=await readFile(path)}
    res.writeHead(200,{'content-type':types[extname(path)]||'application/octet-stream'});res.end(bytes)
  }catch(error){res.writeHead(500,{'content-type':'text/plain'});res.end(error.message)}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const base=`http://127.0.0.1:${server.address().port}`
try {
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,modulesRoot:resolve('runtime/cloudflare'),scriptPath:resolve('runtime/cloudflare/worker.js'),compatibilityDate:'2026-10-14',compatibilityFlags:['nodejs_compat'],cf:false,d1Databases:['DB'],r2Buckets:['FILES'],durableObjects:{HUBS:{className:'WorkspaceHub',useSQLite:true},ROOMS:{className:'ChatRoom',useSQLite:true}},bindings:{AUTH_BASE_URL:base,APP_SECRET:crypto.randomUUID(),MIGRATION_TOKEN:'local-migration',SETUP_TOKEN:'local-setup'},outboundService:request=>{
    if (new URL(request.url).origin === 'https://api.github.com') return Response.json({ tag_name: 'v' + nextRelease.version, immutable: true, draft: false, prerelease: false, body: 'Disposable release fixture', assets: [{ name: 'anycord-release.json' }] })
    if (new URL(request.url).origin === 'https://github.com') { assert(new URL(request.url).pathname.endsWith('/anycord-release.json')); return Response.json(nextRelease) }
    assert.equal(new URL(request.url).origin,'https://api.telegram.org');assert(new URL(request.url).pathname.endsWith('/getMe'))
    return Response.json({ok:true,result:{id:12345,username:'anycord_test_bot',is_bot:true}})
  }}))
  await mf.ready
  let ownerCookie=''
  async function api(path,method='GET',body,owner=true,extra={}) {
    const res=await fetch(base+path,{method,headers:{Origin:base,'content-type':'application/json',...(ownerCookie&&owner?{cookie:ownerCookie}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})})
    const data=await res.json();assert(res.ok,`${path}: ${JSON.stringify(data)}`)
    const cookie=res.headers.getSetCookie().find(value=>value.includes('cellcord.session_token='));if(cookie)ownerCookie=cookie.split(';')[0]
    return data
  }
  await api('/api/_migrate','POST',{},false,{'X-Migration-Token':'local-migration'})
  await api('/api/auth/register','POST',{name:'localowner',password:'correct-horse-battery',setupCode:'local-setup'})
  await api('/api/integrations/telegram','PUT',{botToken,clientId:'',notifications:false})
  await api('/api/installation/authentication','PUT',{passwordLogin:true,registration:true,telegramLogin:false,miniAppLogin:true})
  const workspace=await api('/api/workspaces','POST',{name:'Travel friends'})
  const invitation=await api(`/api/workspaces/${workspace.id}/invites`,'POST',{expiresInHours:1,maxUses:1})
  const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),query_id:'local-browser-proof',user:JSON.stringify({id:424242,first_name:'Local Telegram member'})})
  const check=[...params].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n')
  const key=createHmac('sha256','WebAppData').update(botToken).digest();params.set('hash',createHmac('sha256',key).update(check).digest('hex'))
  browser=await chromium.launch({headless:true})
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'}),page=await context.newPage()
  await page.route('https://telegram.org/js/telegram-web-app.js',route=>route.fulfill({contentType:'text/javascript',body:'window.Telegram={WebApp:{ready(){},setHeaderColor(){},setBackgroundColor(){}}}'}))
  await page.goto(base+'/servers#'+new URLSearchParams({tgWebAppData:params.toString(),tgWebAppVersion:'9.6',tgWebAppPlatform:'ios'}),{waitUntil:'networkidle'})
  await page.getByRole('link',{name:'Join a server',exact:true}).click()
  await page.getByLabel('Invitation link or code').fill(base+'/invite#token='+invitation.token)
  await page.getByRole('button',{name:'Check invitation',exact:true}).click()
  await page.getByRole('heading',{name:'Travel friends',exact:true}).waitFor()
  await page.getByRole('button',{name:'Join as Local Telegram member',exact:true}).click()
  await page.waitForURL(url=>url.pathname.startsWith('/'+workspace.id))
  await page.locator('.discord-shell').waitFor()
  const session=await context.request.get(base+'/api/auth/status'),member=(await session.json()).user
  assert.equal(member.name,'Local Telegram member');assert.equal(member.telegram,true)
  const bootstrap=await context.request.get(base+'/api/bootstrap?workspace='+workspace.id);assert.equal(bootstrap.status(),200)
  assert((await bootstrap.json()).workspaces.some(item=>item.id===workspace.id))
  const invites=await api(`/api/workspaces/${workspace.id}/invites`);assert.equal(invites[0].uses,1)
  await page.goto(base+'/servers',{waitUntil:'networkidle'})
  await page.getByRole('link',{name:'Travel friends Open server'}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Installation Settings',exact:true}).count(),0)
  console.log('PASS actual built Nuxt client → local Cloudflare Worker/D1/Better Auth: signed Mini App login, pasted invitation, preview, explicit accept, one use, membership/channel access and refreshed picker')
  const ownerContext=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'})
  const [name,value]=ownerCookie.split('=');await ownerContext.addCookies([{name,value,url:base}])
  const ownerPage=await ownerContext.newPage();await ownerPage.goto(base+'/servers',{waitUntil:'networkidle'})
  await ownerPage.getByRole('button',{name:'User Settings',exact:true}).click()
  for(let i=0;i<3;i++){
    await ownerPage.getByRole('button',{name:'Installation Settings',exact:true}).click()
    await ownerPage.getByRole('button',{name:'Save Authentication',exact:true}).waitFor()
    assert.equal(await ownerPage.getByRole('dialog').count(),1)
    await ownerPage.getByRole('button',{name:'Back to User Settings',exact:true}).click()
  }
  await ownerPage.getByRole('button',{name:'Installation Settings',exact:true}).click()
  await ownerPage.getByRole('button',{name:'Backups & updates',exact:true}).click()
  await ownerPage.getByRole('heading',{name:'Backups & updates',exact:true}).waitFor()
  assert(await ownerPage.getByRole('button',{name:'Create backup',exact:true}).isDisabled())
  await ownerPage.getByText('Operations runner is offline',{exact:true}).waitFor()
  process.env.ANYCORD_BROWSER_TEST_MIGRATION_TOKEN='local-migration'
  const operator=operationClient({origin:base,migrationTokenEnv:'ANYCORD_BROWSER_TEST_MIGRATION_TOKEN'})
  await operator('/heartbeat',{method:'POST',body:{}})
  await ownerPage.getByRole('button',{name:'Refresh runner status',exact:true}).click()
  await ownerPage.getByText('Runner connected · backups are kept outside the application by your operator.',{exact:true}).waitFor()
  await ownerPage.getByLabel('Back up every (hours)',{exact:true}).fill('12')
  await ownerPage.getByLabel('Keep recent recovery points',{exact:true}).fill('2')
  await ownerPage.getByRole('button',{name:'Save backup policy',exact:true}).click()
  await ownerPage.getByText('Backup schedule and retention saved.',{exact:true}).waitFor()
  assert.deepEqual((await operator('/status')).policy,{backupHours:12,retainBackups:2})
  await ownerPage.getByRole('button',{name:'Create backup',exact:true}).click()
  await ownerPage.getByText('Waiting for runner',{exact:true}).waitFor()
  const claim=await operator('/claim',{method:'POST',body:{runnerId:crypto.randomUUID()}})
  await operator(`/jobs/${claim.job.id}/snapshot`,{method:'POST',key:claim.key,body:{}})
  await ownerPage.getByText('Copying frozen data and files',{exact:true}).waitFor()
  await ownerPage.getByText('Installation is in maintenance',{exact:true}).waitFor()
  const backup=await createBackup(operator,claim.job,claim.key,backupDirectory)
  await ownerPage.getByText(backup.manifest.id,{exact:true}).waitFor()
  await ownerPage.getByText('Installation is in maintenance',{exact:true}).waitFor({state:'hidden'})
  const update=ownerPage.getByRole('button',{name:'Back up and update to '+nextRelease.version,exact:true})
  await update.click();await ownerPage.getByText('Waiting for runner',{exact:true}).waitFor()
  await ownerPage.getByRole('button',{name:'Cancel operation',exact:true}).click()
  await ownerPage.getByRole('button',{name:'Cancel operation',exact:true}).waitFor({state:'hidden'})
  assert.equal((await operator('/status')).jobs[0].phase,'cancelled')
  await mkdir('output/operations',{recursive:true})
  for(const viewport of [{width:390,height:844},{width:1280,height:900}]) {
    await ownerPage.setViewportSize(viewport)
    assert(await ownerPage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'No page overflow')
    const card=ownerPage.locator('.operations-settings');assert(await card.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'No operations panel overflow')
    await ownerPage.screenshot({path:`output/operations/settings-${viewport.width}.png`})
  }
  console.log('PASS actual owner operations UI at 390/1280px: offline guard, runner heartbeat, saved policy, real Worker backup/maintenance/progress/checkpoint, exact release choice and cancellation')
  await ownerPage.keyboard.press('Escape');await ownerPage.getByRole('dialog').waitFor({state:'hidden'})
  console.log('PASS actual local installation owner settings: authentication policy loads, scope/back repeats in one dialog and Escape closes')
}finally{delete process.env.ANYCORD_BROWSER_TEST_MIGRATION_TOKEN;await browser?.close();await mf?.dispose();await new Promise(resolve=>server.close(resolve));await rm(backupDirectory,{recursive:true,force:true})}

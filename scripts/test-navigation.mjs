import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp,rm } from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
const dir=await mkdtemp(join(tmpdir(),'anycord-navigation-'))
try {
 await build({entryPoints:['shared/navigation.ts'],outfile:join(dir,'navigation.mjs'),bundle:true,format:'esm',platform:'node'})
 const {serverPath,safeNext}=await import(pathToFileURL(join(dir,'navigation.mjs')))
 assert.equal(serverPath('main'),'\/main')
 assert.equal(serverPath('space id','general'),'\/space%20id/general')
 assert.equal(serverPath('main','channel/id'),'\/main/channel%2Fid')
 assert.equal(safeNext('/main/general?thread=thread-id#message-a'),'/main/general?thread=thread-id#message-a')
 for(const value of ['//evil.example','https://evil.example','/\\evil.example','/login','/',undefined])assert.equal(safeNext(value),'/servers')
 console.log('PASS: server/channel route encoding, preserved deep-link targets and blocked external login redirects.')
 await build({entryPoints:['shared/invitations.ts'],outfile:join(dir,'invitations.mjs'),bundle:true,format:'esm',platform:'node'})
 const {invitationToken,pendingInvitationKey,telegramInvitationLink}=await import(pathToFileURL(join(dir,'invitations.mjs')))
 const token='a'.repeat(48),origin='https://chat.example'
 for(const value of [token,` ${origin}/invite#token=${token} `,`/invite#token=${token}`])assert.equal(invitationToken(value,origin),token)
 for(const value of ['', 'short', `${origin}/invite#token=invalid`, `${origin}/login#token=${token}`, `javascript:alert(1)`, `https://user:password@chat.example/invite#token=${token}`, `${origin}/invite?token=${token}`])assert.throws(()=>invitationToken(value,origin))
 assert.throws(()=>invitationToken(`https://other.example/invite#token=${token}`,origin),/other.example.*accounts are separate/)
 assert.notEqual(pendingInvitationKey(),pendingInvitationKey('https://remote.example'))
 const telegram=telegramInvitationLink(token,'anycord_test_bot')
 assert.equal(telegram,`https://t.me/anycord_test_bot?startapp=invite_${token}`)
 assert.equal(invitationToken(telegram,origin,'anycord_test_bot'),token)
 assert.equal(invitationToken(telegram,origin,'ANYCORD_TEST_BOT'),token)
 for(const bot of ['', 'other_bot'])assert.throws(()=>invitationToken(telegram,origin,bot),/Open this invitation in Telegram/)
 for(const value of [telegram+'&startapp=invite_'+token,telegram+'&other=1',telegram+'#extra',telegram.replace('invite_','invalid_'),telegram.replace('t.me','evil.example')])assert.throws(()=>invitationToken(value,origin,'anycord_test_bot'))
 for(const bot of ['', 'bot/path', 'bot?startapp=evil'])assert.equal(telegramInvitationLink(token,bot),'')
 assert.equal(telegramInvitationLink('invalid','anycord_test_bot'),'')
 console.log('PASS: invitation parsing rejects malformed and foreign links; pending tokens are installation-scoped.')
}finally{await rm(dir,{recursive:true,force:true})}

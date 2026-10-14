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
}finally{await rm(dir,{recursive:true,force:true})}

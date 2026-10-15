import { backupTables, cloudBackupManifestSchema, bytesDigest, encodeBackupPayload, decodeBackupPayload, authenticateBackupManifest } from '../shared/operations'
import type { BackupStorageConfig } from '../shared/backup-settings'
import { backupConfig, backupRequest, boundedBackupBytes } from './backup-storage'
import { backupObject } from './storage'
import { encrypt, decrypt, digest, HttpError } from './security'
import { dispatchCloudUpdate } from './cloud-updates'
import build from '../shared/build-info.json'

type Table = typeof backupTables[number]
type Manifest = ReturnType<typeof cloudBackupManifestSchema.parse>
type Payload = Manifest['secrets']
type Progress = { jobId: string; backupId: string; installationId: string; engine: 'cloudflare' | 'celld'; kind: 'backup' | 'update'; config: BackupStorageConfig; phase: 'tables' | 'objects' | 'secrets' | 'manifest' | 'dispatch'; table: number; cursor: number; part: number; objectCursor: string; tables: { name: Table; rows: number; columns: string[] }[]; createdAt: number; attempts: number }
const metadataLimit = 8 * 1024 * 1024
export function initializeBackupStorage(storage: DurableObjectStorage) {
  storage.sql.exec('CREATE TABLE IF NOT EXISTS backup_progress (id INTEGER PRIMARY KEY,data TEXT NOT NULL)')
  storage.sql.exec('CREATE TABLE IF NOT EXISTS backup_payloads (path TEXT PRIMARY KEY,kind TEXT NOT NULL,table_name TEXT,object_id TEXT,rows INTEGER NOT NULL,nonce TEXT NOT NULL,verified INTEGER NOT NULL,data TEXT NOT NULL)')
  storage.sql.exec('CREATE TABLE IF NOT EXISTS backup_gc (id INTEGER PRIMARY KEY,data TEXT NOT NULL)')
  storage.sql.exec('CREATE TABLE IF NOT EXISTS backup_gc_paths (path TEXT PRIMARY KEY)')
  storage.sql.exec('CREATE TABLE IF NOT EXISTS backup_runtime (id INTEGER PRIMARY KEY,engine TEXT NOT NULL)')
}
const hex = (bytes: Uint8Array) => [...bytes].map(x => x.toString(16).padStart(2, '0')).join('')
const unhex = (text: string) => Uint8Array.from(text.match(/../g)!, x => parseInt(x, 16))
function readProgress(storage: DurableObjectStorage) { const row = storage.sql.exec<{ data: string }>('SELECT data FROM backup_progress WHERE id=1').toArray()[0]; return row ? JSON.parse(row.data) as Progress : null }
function saveProgress(storage: DurableObjectStorage, progress: Progress) { storage.sql.exec('INSERT INTO backup_progress (id,data) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',JSON.stringify(progress)) }
function root(p: Pick<Progress,'installationId'|'backupId'>) { return `anycord-backups/${p.installationId}/${p.backupId}` }
async function fence(env: Env, p: Progress) {
  const active = await env.DB.prepare("SELECT 1 FROM installation_jobs j JOIN installation_state s ON s.maintenance_job=j.id WHERE j.id=? AND j.status='running'").bind(p.jobId).first()
  if (!active) throw new HttpError(409, 'This backup was cancelled or its maintenance claim changed')
}
export async function beginNativeBackup(env: Env, storage: DurableObjectStorage, jobId: string, engine: 'cloudflare' | 'celld') {
  storage.sql.exec('INSERT INTO backup_runtime VALUES (1,?) ON CONFLICT(id) DO UPDATE SET engine=excluded.engine',engine)
  if (readProgress(storage)) { await storage.setAlarm(Date.now()+100); return { ok: true as const } }
  const job = await env.DB.prepare("SELECT kind FROM installation_jobs WHERE id=? AND status='queued' AND runner_id='native-s3-queued'").bind(jobId).first<{ kind: 'backup' | 'update' }>()
  if (!job) return { ok: true as const }
  const config = await backupConfig(env)
  if (!config?.verified) throw new HttpError(409, 'Configure and verify separate S3 backup storage first')
  const state = await env.DB.prepare('SELECT installation_id FROM installation_state WHERE id=1').first<{ installation_id: string }>()
  const p: Progress = { jobId, backupId: crypto.randomUUID(), installationId: state!.installation_id, engine, kind: job.kind, config, phase: 'tables', table: 0, cursor: 0, part: 0, objectCursor: '', tables: [], createdAt: Date.now(), attempts: 0 }
  // Persist the continuation and wakeup before taking the database write fence.
  storage.transactionSync(() => { storage.sql.exec('DELETE FROM backup_payloads'); saveProgress(storage,p) })
  await storage.setAlarm(Date.now()+100)
  await env.DB.batch([
    env.DB.prepare("UPDATE installation_jobs SET status='running',phase='snapshot',runner_id='native-s3',updated_at=? WHERE id=? AND status='queued'").bind(Date.now(),jobId),
    env.DB.prepare("UPDATE installation_state SET maintenance_job=? WHERE id=1 AND maintenance_job IS NULL AND EXISTS (SELECT 1 FROM installation_jobs WHERE id=? AND status='running' AND runner_id='native-s3')").bind(jobId,jobId),
  ])
  return { ok: true as const }
}
async function upload(env: Env, storage: DurableObjectStorage, p: Progress, path: string, bytes: Uint8Array, kind: string, tableName: string | null = null, objectId: string | null = null, rows = 0) {
  await fence(env,p)
  let entry = storage.sql.exec<{ nonce: string; verified: number; data: string }>('SELECT nonce,verified,data FROM backup_payloads WHERE path=?',path).toArray()[0]
  const nonce = entry ? unhex(entry.nonce) : crypto.getRandomValues(new Uint8Array(12)), encoded = await encodeBackupPayload(bytes,p.config.recoveryKey,nonce)
  const metadata: Payload = { path, size: bytes.length, sha256: await bytesDigest(bytes), encodedSize: encoded.length, encodedSha256: await bytesDigest(encoded) }
  if (entry && entry.data !== JSON.stringify(metadata)) throw new Error('The fenced backup payload changed while retrying')
  if (!entry) storage.sql.exec('INSERT INTO backup_payloads VALUES (?,?,?,?,?,?,0,?)',path,kind,tableName,objectId,rows,hex(nonce),JSON.stringify(metadata))
  if (!entry?.verified) {
    const response = await backupRequest(p.config,`${root(p)}/${path}`,'PUT',encoded)
    if (!response.ok) { await response.body?.cancel(); throw new Error('Backup upload failed') }; await response.body?.cancel()
    const actual = await boundedBackupBytes(await backupRequest(p.config,`${root(p)}/${path}`),metadata.encodedSize)
    if (actual.length !== metadata.encodedSize || await bytesDigest(actual) !== metadata.encodedSha256 || await bytesDigest(await decodeBackupPayload(actual,p.config.recoveryKey)) !== metadata.sha256) throw new Error('S3 backup readback failed')
    await fence(env,p)
    storage.sql.exec('UPDATE backup_payloads SET verified=1 WHERE path=?',path)
  }
}
function entries(storage: DurableObjectStorage, kind: string, table?: string) {
  return storage.sql.exec<{ data: string; object_id: string | null; rows: number }>('SELECT data,object_id,rows FROM backup_payloads WHERE kind=? AND (? IS NULL OR table_name=?) ORDER BY path',kind,table || null,table || null).toArray()
}
async function complete(env: Env, storage: DurableObjectStorage, p: Progress) {
  await fence(env,p)
  const tables = p.tables.map(t => { const parts=entries(storage,'table',t.name); if (parts.reduce((n,x)=>n+x.rows,0)!==t.rows) throw new Error('Frozen table count changed');return {...t,parts:parts.map(x=>JSON.parse(x.data) as Payload)} })
  const objects = entries(storage,'object').map(x=>({...JSON.parse(x.data) as Payload,id:x.object_id!})), secret = entries(storage,'secrets')[0]
  const manifest = cloudBackupManifestSchema.parse({ format: 2, encrypted: 'AES-256-GCM', authentication: '0'.repeat(64), id: p.backupId, installationId: p.installationId, engine: p.engine, origin: env.AUTH_BASE_URL, build, createdAt: p.createdAt, tables, objects, secrets: JSON.parse(secret!.data) })
  manifest.authentication = await authenticateBackupManifest(manifest,p.config.recoveryKey)
  const bytes = new TextEncoder().encode(JSON.stringify(manifest)+'\n')
  if (bytes.length > metadataLimit) throw new Error('Backup inventory exceeds the supported manifest size')
  const manifestKey = `${root(p)}/manifest.json`, hash = await bytesDigest(bytes)
  const response = await backupRequest(p.config,manifestKey,'PUT',bytes)
  if (!response.ok) { await response.body?.cancel(); throw new Error('Backup manifest upload failed') };await response.body?.cancel()
  const actual = await boundedBackupBytes(await backupRequest(p.config,manifestKey),bytes.length)
  if (await bytesDigest(actual)!==hash) throw new Error('Backup manifest readback failed')
  await fence(env,p)
  const result = { backupId: p.backupId, manifestHash: hash, files: objects.length, bytes: [...tables.flatMap(t=>t.parts),...objects,manifest.secrets].reduce((n,x)=>n+x.size,0) }
  await env.DB.batch([
    env.DB.prepare("UPDATE installation_state SET installation_id=CASE WHEN maintenance_job=? AND EXISTS (SELECT 1 FROM installation_jobs WHERE id=? AND status='running') THEN installation_id ELSE NULL END WHERE id=1").bind(p.jobId,p.jobId),
    env.DB.prepare('INSERT OR IGNORE INTO installation_backups (id,job_id,created_at,manifest_hash,manifest_key,destination) VALUES (?,?,?,?,?,?)').bind(p.backupId,p.jobId,p.createdAt,hash,manifestKey,await encrypt(JSON.stringify(p.config),env.APP_SECRET)),
    env.DB.prepare("UPDATE installation_jobs SET checkpoint=?,result=?,phase='checkpoint',status=?,runner_id=NULL,claim_hash=NULL,error=NULL,updated_at=? WHERE id=? AND status='running'").bind(p.backupId,JSON.stringify(result),p.kind==='backup'?'complete':'running',Date.now(),p.jobId),
    env.DB.prepare('UPDATE installation_state SET last_backup=?,maintenance_job=? WHERE maintenance_job=?').bind(Date.now(),p.kind==='backup'?null:p.jobId,p.jobId),
  ])
  if (p.kind==='update') { p.phase='dispatch'; saveProgress(storage,p); await dispatchCloudUpdate(env,p.jobId) }
  storage.transactionSync(()=>{ storage.sql.exec('DELETE FROM backup_progress'); storage.sql.exec('DELETE FROM backup_payloads') })
}
export async function nativeBackupStep(env: Env, storage: DurableObjectStorage) {
  const p=readProgress(storage);if(!p)return
  try {
    if(p.phase==='dispatch'){ await dispatchCloudUpdate(env,p.jobId);storage.sql.exec('DELETE FROM backup_progress');storage.sql.exec('DELETE FROM backup_payloads');return }
    await fence(env,p)
    if(p.phase==='tables'){
      const name=backupTables[p.table]
      if(!name){p.phase='objects';saveProgress(storage,p);return}
      if(!p.tables[p.table]){
        const filter=name==='attachments'?" WHERE status='uploaded' AND message_id IS NOT NULL":''
        const count=await env.DB.prepare(`SELECT count(*) AS n FROM "${name}"${filter}`).first<{n:number}>(),columns=(await env.DB.prepare(`PRAGMA table_info("${name}")`).all<{name:string}>()).results.map(x=>x.name)
        p.tables.push({name,rows:count!.n,columns});saveProgress(storage,p)
      }
      const filter=name==='attachments'?" AND status='uploaded' AND message_id IS NOT NULL":''
      const rows=(await env.DB.prepare(`SELECT rowid AS __cursor,* FROM "${name}" WHERE rowid>?${filter} ORDER BY rowid LIMIT 25`).bind(p.cursor).all<Record<string,string|number|null>>()).results
      if(!rows.length){p.table++;p.cursor=0;p.part=0;saveProgress(storage,p);return}
      const bytes=new TextEncoder().encode(rows.map(({__cursor,...row})=>JSON.stringify(row)+'\n').join(''))
      if(bytes.length>2*1024*1024)throw new Error('Backup table page exceeds its size limit')
      await upload(env,storage,p,`tables/${name}/${String(p.part).padStart(10,'0')}.jsonl`,bytes,'table',name,null,rows.length)
      p.cursor=Number(rows.at(-1)!.__cursor);p.part++;saveProgress(storage,p)
    }else if(p.phase==='objects'){
      const row=await env.DB.prepare("SELECT id,size FROM attachments WHERE id>? AND status='uploaded' AND message_id IS NOT NULL ORDER BY id LIMIT 1").bind(p.objectCursor).first<{id:string;size:number}>()
      if(!row){p.phase='secrets';saveProgress(storage,p);return}
      const bytes=await boundedBackupBytes(await backupObject(env,row.id),row.size)
      if(bytes.length!==row.size)throw new Error('Private file size differs from the frozen inventory')
      await upload(env,storage,p,`objects/${row.id}`,bytes,'object',null,row.id);p.objectCursor=row.id;saveProgress(storage,p)
    }else if(p.phase==='secrets'){
      await upload(env,storage,p,'private/secrets.json',new TextEncoder().encode(JSON.stringify({APP_SECRET:env.APP_SECRET,MIGRATION_TOKEN:env.MIGRATION_TOKEN,SETUP_TOKEN:env.SETUP_TOKEN||''})+'\n'),'secrets');p.phase='manifest';saveProgress(storage,p)
    }else await complete(env,storage,p)
    const next=readProgress(storage);if(next){next.attempts=0;saveProgress(storage,next)}
  }catch(error){
    p.attempts++
    const active=await env.DB.prepare("SELECT status FROM installation_jobs WHERE id=?").bind(p.jobId).first<{status:string}>()
    if(!active||active.status==='complete'||active.status==='failed') { storage.sql.exec('DELETE FROM backup_progress');return }
    const rejected=error instanceof HttpError&&error.status===424
    if(p.attempts>=5 || error instanceof HttpError&&error.status===409 || rejected){
      await env.DB.batch([
        env.DB.prepare("UPDATE installation_jobs SET status='failed',phase=?,error=?,updated_at=? WHERE id=? AND status='running'").bind(p.phase==='dispatch'?'dispatch-failed':'backup-failed',p.phase==='dispatch'?'Cloud update could not start. Review the executor and retry this update.':'S3 backup failed verification. Check storage and create a new backup.',Date.now(),p.jobId),
        env.DB.prepare('UPDATE installation_state SET maintenance_job=NULL WHERE maintenance_job=? AND (?!=\'dispatch\' OR ?=1)').bind(p.jobId,p.phase,Number(rejected)),
      ]);storage.sql.exec('DELETE FROM backup_progress')
    }else saveProgress(storage,p)
  }finally{const current=readProgress(storage);if(current)await storage.setAlarm(Date.now()+(current.attempts?Math.min(60_000,1000*2**current.attempts):100))}
}
export async function nativeBackupRetention(env: Env, storage: DurableObjectStorage) {
  if(readProgress(storage))return
  if(await env.DB.prepare("SELECT 1 FROM installation_jobs WHERE status IN ('queued','running')").first())return
  let row=storage.sql.exec<{data:string}>('SELECT data FROM backup_gc WHERE id=1').toArray()[0]
  if(!row){
    const state=await env.DB.prepare('SELECT retain_backups,installation_id FROM installation_state WHERE id=1').first<{retain_backups:number;installation_id:string}>()
    const candidate=await env.DB.prepare("SELECT b.id,b.manifest_hash,b.manifest_key,b.destination FROM installation_backups b WHERE b.id NOT IN (SELECT id FROM installation_backups ORDER BY created_at DESC,id DESC LIMIT ?) AND NOT EXISTS (SELECT 1 FROM installation_jobs j WHERE j.checkpoint=b.id AND j.kind='update' AND j.status!='complete') ORDER BY b.created_at DESC,b.id DESC LIMIT 1").bind(state!.retain_backups).first<{id:string;manifest_hash:string;manifest_key:string;destination:string}>()
    if(!candidate)return
    if(await env.DB.prepare("SELECT 1 FROM installation_jobs WHERE checkpoint=? AND kind='update' AND status!='complete'").bind(candidate.id).first())return
    const config:BackupStorageConfig=JSON.parse(await decrypt(candidate.destination,env.APP_SECRET)),bytes=await boundedBackupBytes(await backupRequest(config,candidate.manifest_key),metadataLimit)
    if(await bytesDigest(bytes)!==candidate.manifest_hash)return
    const manifest=cloudBackupManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
    if(manifest.installationId!==state!.installation_id||manifest.id!==candidate.id)return
    const base=candidate.manifest_key.slice(0,-'/manifest.json'.length)
    const value={id:candidate.id,manifestKey:candidate.manifest_key,config,base}
    storage.transactionSync(()=>{
      storage.sql.exec('DELETE FROM backup_gc_paths')
      for(const part of [...manifest.tables.flatMap(t=>t.parts),...manifest.objects,manifest.secrets])storage.sql.exec('INSERT INTO backup_gc_paths (path) VALUES (?)',part.path)
      storage.sql.exec('INSERT INTO backup_gc (id,data) VALUES (1,?)',JSON.stringify(value))
    });row={data:JSON.stringify(value)}
  }
  const gc=JSON.parse(row.data) as {id:string;manifestKey:string;base:string;config:BackupStorageConfig}
  if(await env.DB.prepare("SELECT 1 FROM installation_jobs WHERE checkpoint=? AND kind='update' AND status!='complete'").bind(gc.id).first())return
  try{
    const paths=storage.sql.exec<{path:string}>('SELECT path FROM backup_gc_paths ORDER BY path LIMIT 5').toArray()
    for(const part of paths){const response=await backupRequest(gc.config,`${gc.base}/${part.path}`,'DELETE');await response.body?.cancel();if(!response.ok&&response.status!==404)throw new Error('Backup retention delete failed');storage.sql.exec('DELETE FROM backup_gc_paths WHERE path=?',part.path)}
    if(!storage.sql.exec('SELECT path FROM backup_gc_paths LIMIT 1').toArray().length){const response=await backupRequest(gc.config,gc.manifestKey,'DELETE');await response.body?.cancel();if(!response.ok&&response.status!==404)throw new Error('Backup retention manifest delete failed');await env.DB.prepare('DELETE FROM installation_backups WHERE id=?').bind(gc.id).run();storage.sql.exec('DELETE FROM backup_gc')}
  }finally{await storage.setAlarm(Date.now()+1000)}
}
export async function pumpNativeBackups(env: Env, storage: DurableObjectStorage) {
  await nativeBackupStep(env,storage)
  await nativeBackupRetention(env,storage)
  if(!readProgress(storage)) {
    const queued=await env.DB.prepare("SELECT id FROM installation_jobs WHERE status='queued' AND runner_id='native-s3-queued' LIMIT 1").first<{id:string}>()
    const runtime=storage.sql.exec<{engine:'cloudflare'|'celld'}>('SELECT engine FROM backup_runtime WHERE id=1').toArray()[0]
    if(queued&&runtime)await beginNativeBackup(env,storage,queued.id,runtime.engine)
  }
}
export async function cloudRecovery(env: Env, jobId: string) {
  const job=await env.DB.prepare('SELECT checkpoint,result FROM installation_jobs WHERE id=?').bind(jobId).first<{checkpoint:string|null;result:string|null}>()
  const row=job?.checkpoint?await env.DB.prepare('SELECT * FROM installation_backups WHERE id=? AND job_id=?').bind(job.checkpoint,jobId).first<{id:string;manifest_key:string;manifest_hash:string;destination:string}>():null
  if(!row||JSON.parse(job!.result||'{}').manifestHash!==row.manifest_hash)throw new HttpError(409,'This update has no verified S3 recovery point')
  const config:BackupStorageConfig=JSON.parse(await decrypt(row.destination,env.APP_SECRET)),bytes=await boundedBackupBytes(await backupRequest(config,row.manifest_key),metadataLimit)
  if(await bytesDigest(bytes)!==row.manifest_hash)throw new HttpError(409,'Recovery manifest integrity check failed')
  const manifest=cloudBackupManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
  if(manifest.id!==row.id)throw new HttpError(409,'Recovery point identity mismatch')
  return {config,bytes,manifest,base:row.manifest_key.slice(0,-'/manifest.json'.length)}
}

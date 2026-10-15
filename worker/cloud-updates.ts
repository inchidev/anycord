import { cloudUpdateInputSchema, type CloudUpdateConfig } from '../shared/backup-settings'
import { assertOperationsIdle } from './backup-storage'
import { getSetting, setSetting } from './store'
import { decrypt, encrypt, HttpError } from './security'

export async function cloudUpdateConfig(env: Env): Promise<CloudUpdateConfig | null> {
  const value = await getSetting(env, 'cloudUpdates')
  return value ? JSON.parse(await decrypt(value, env.APP_SECRET)) : null
}
export async function cloudUpdateStatus(env: Env) {
  const c = await cloudUpdateConfig(env)
  return { configured: !!c, repository: c?.repository || '', workflow: c?.workflow || 'installation-update.yml', verified: c?.verified || false }
}
async function github(config: CloudUpdateConfig, suffix: string, body?: unknown) {
  return fetch(`https://api.github.com/repos/${config.repository}/actions/workflows/${encodeURIComponent(config.workflow)}${suffix}`, {
    method: body ? 'POST' : 'GET', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Anycord', Authorization: `Bearer ${config.token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: AbortSignal.timeout(15_000),
  })
}
export async function saveCloudUpdates(env: Env, raw: unknown) {
  await assertOperationsIdle(env)
  const input = cloudUpdateInputSchema.parse(raw), old = await cloudUpdateConfig(env)
  const token = input.token || (old?.repository === input.repository && old.workflow === input.workflow ? old.token : '')
  if (!token) throw new HttpError(400, 'A GitHub token scoped to this repository and Actions is required')
  const config: CloudUpdateConfig = { ...input, token, verified: false }, response = await github(config, '')
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, 'Cannot access the update workflow. Check repository, workflow and token.') }
  const value = await response.json() as { state?: string }
  if (value.state !== 'active') throw new HttpError(400, 'Enable the installation update workflow in the selected repository')
  config.verified = true
  await assertOperationsIdle(env)
  await setSetting(env, 'cloudUpdates', await encrypt(JSON.stringify(config), env.APP_SECRET))
  return cloudUpdateStatus(env)
}
export async function dispatchCloudUpdate(env: Env, jobId: string, retry = false) {
  const config = await cloudUpdateConfig(env)
  if (!config?.verified) throw new HttpError(409, 'Configure a verified GitHub Actions update workflow first')
  const job = await env.DB.prepare("SELECT id,target_version,checkpoint,status FROM installation_jobs WHERE id=? AND kind='update' AND status IN ('running','failed')").bind(jobId).first<{ id: string; target_version: string; checkpoint: string | null; status: string }>()
  const state = await env.DB.prepare('SELECT installation_id,maintenance_job FROM installation_state WHERE id=1').first<{ installation_id: string; maintenance_job: string | null }>()
  if (!job?.checkpoint || state?.maintenance_job !== jobId) throw new HttpError(409, 'A verified S3 recovery point and update maintenance fence are required')
  if (retry && job.status !== 'failed') throw new HttpError(409, 'Wait for the active cloud update to finish before retrying')
  const dispatchedAt = Date.now()
  const dispatching = await env.DB.prepare("UPDATE installation_jobs SET phase='dispatching',status='running',result=json_set(result,'$.cloudDispatchAt',?),updated_at=? WHERE id=? AND status=? RETURNING id").bind(dispatchedAt,dispatchedAt,jobId,job.status).first()
  if (!dispatching) throw new HttpError(409, 'The update changed while preparing its cloud job')
  try {
    const response = await github(config, '/dispatches', { ref: 'main', inputs: { job_id: job.id, installation_id: state.installation_id, origin: env.AUTH_BASE_URL, version: job.target_version } })
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(424, 'GitHub Actions rejected the update. Check the workflow inputs, token and Actions write permission.') }
    await response.body?.cancel()
  } catch (error) {
    if (retry) await env.DB.prepare("UPDATE installation_jobs SET status='failed',phase='dispatch-failed',error='Cloud update could not restart. Review the executor and retry.',updated_at=? WHERE id=? AND phase='dispatching' AND updated_at=?").bind(Date.now(),jobId,dispatchedAt).run()
    throw error
  }
  await env.DB.prepare("UPDATE installation_jobs SET phase='waiting-for-deployment',status='running',error=NULL,updated_at=? WHERE id=? AND status IN ('running','failed')").bind(Date.now(),jobId).run()
  return { ok: true as const }
}
export async function refreshCloudUpdate(env: Env) {
  const job=await env.DB.prepare("SELECT j.id,j.runner_id,j.updated_at,j.result FROM installation_jobs j JOIN installation_backups b ON b.job_id=j.id WHERE j.kind='update' AND j.status='running' ORDER BY j.created_at DESC LIMIT 1").first<{id:string;runner_id:string|null;updated_at:number;result:string}>()
  if(!job||job.updated_at>Date.now()-15_000)return
  const config=await cloudUpdateConfig(env);if(!config)return
  const polledAt=Date.now(),claimed=await env.DB.prepare("UPDATE installation_jobs SET updated_at=? WHERE id=? AND status='running' AND updated_at=? RETURNING id").bind(polledAt,job.id,job.updated_at).first()
  if(!claimed)return
  try{
    const response=await github(config,'/runs?event=workflow_dispatch&branch=main&per_page=100')
    if(!response.ok){await response.body?.cancel();return}
    const data=await response.json() as {workflow_runs?:{display_title?:string;created_at:string;status:string;conclusion:string|null}[]}
    const dispatchedAt = JSON.parse(job.result).cloudDispatchAt
    if (typeof dispatchedAt !== 'number') return
    const runs=data.workflow_runs?.filter(r=>r.display_title?.endsWith(`job ${job.id}`) && Date.parse(r.created_at) >= Math.floor(dispatchedAt / 1000) * 1000)||[]
    if(!runs.length||runs.some(r=>r.status!=='completed'))return
    // The cloud workflow claims the job before any deployment. A failed run
    // without a claim is safe to unlock; an interrupted deployment stays fenced.
    await env.DB.batch([
      env.DB.prepare("UPDATE installation_jobs SET status='failed',phase='cloud-job-failed',error='The cloud workflow ended before confirming this update. Review its run and retry.',updated_at=? WHERE id=? AND status='running' AND runner_id IS ? AND updated_at=?").bind(Date.now(),job.id,job.runner_id,polledAt),
      env.DB.prepare("UPDATE installation_state SET maintenance_job=NULL WHERE maintenance_job=? AND EXISTS (SELECT 1 FROM installation_jobs WHERE id=? AND phase='cloud-job-failed' AND runner_id IS NULL)").bind(job.id,job.id),
    ])
  }catch{ /* The installation remains fenced if the executor cannot be observed. */ }
}

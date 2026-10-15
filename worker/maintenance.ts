import { HttpError } from './security'

export async function maintenanceActive(env: Env) {
  // Old-schema startup is allowed only until the migration creates this table.
  const exists = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='installation_state'").first()
  if (!exists) return false
  const state = await env.DB.prepare('SELECT maintenance_job FROM installation_state WHERE id=1').first<{ maintenance_job: string | null }>()
  if (!state) throw new HttpError(503, 'Installation maintenance state is unavailable')
  return !!state.maintenance_job
}
export async function requireOutbound(env: Env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='restored_outbound_disabled'").first<{ value: string }>()
  if (row?.value === 'true') throw new HttpError(409, 'External integrations are disabled after restore. The installation owner must enable them in Backups & updates.')
}

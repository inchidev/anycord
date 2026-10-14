import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { huddles, huddleParticipants } from '../db/schema'
import type { Integrations, User } from '../shared/contracts'
import { database, getSetting, getMessages } from './store'
import { decrypt, HttpError } from './security'

export async function integrationStatus(env: Env): Promise<Integrations> {
  const [token, accountId, appId, preset, ai, model] = await Promise.all([
    getSetting(env, 'realtimeToken'), getSetting(env, 'realtimeAccountId'), getSetting(env, 'realtimeAppId'), getSetting(env, 'realtimePreset'), getSetting(env, 'openrouterKey'), getSetting(env, 'aiModel'),
  ])
  return { realtimeConfigured: !!(token && accountId && appId && preset), realtimeAccountId: accountId, realtimeAppId: appId, realtimePreset: preset || 'group_call_participant', aiConfigured: !!ai, aiModel: model || 'openai/gpt-4.1-mini', email: 'later' }
}
export async function realtimeRequest(env: Env, path: string, method = 'GET', body?: unknown) {
  const config = await integrationStatus(env)
  if (!config.realtimeConfigured) throw new HttpError(409, 'Set up Cloudflare RealtimeKit in Server Settings → Integrations first')
  const key = await decrypt(await getSetting(env, 'realtimeToken'), env.APP_SECRET)
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.realtimeAccountId)}/realtime/kit/${encodeURIComponent(config.realtimeAppId)}${path}`, {
    method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
  })
  const result = z.object({ success: z.boolean(), data: z.unknown().optional() }).safeParse(await response.json())
  if (!response.ok || !result.success || !result.data.success) throw new HttpError(502, `RealtimeKit rejected the request (${response.status}). Check the credentials and preset.`)
  return result.data.data
}
export async function joinHuddle(env: Env, channelId: string, title: string, user: User) {
  const db = database(env)
  const config = await integrationStatus(env)
  if (!config.realtimeConfigured) throw new HttpError(409, 'Set up Cloudflare RealtimeKit in Server Settings → Integrations first')
  let meeting = await db.select().from(huddles).where(eq(huddles.channelId, channelId)).get()
  if (!meeting) {
    const created = z.object({ id: z.uuid() }).parse(await realtimeRequest(env, '/meetings', 'POST', {
      title: `Anycord · ${title}`, record_on_start: false, session_keep_alive_time_in_secs: 60,
    }))
    meeting = { channelId, roomName: created.id, url: '', expiresAt: 0 }
    await db.insert(huddles).values(meeting).run()
  }
  const participant = z.object({ id: z.uuid(), token: z.string().min(1) }).parse(await realtimeRequest(env, `/meetings/${meeting.roomName}/participants`, 'POST', {
    name: user.name, custom_participant_id: `${user.id}:${crypto.randomUUID()}`, preset_name: config.realtimePreset,
  }))
  await db.insert(huddleParticipants).values({ id: participant.id, userId: user.id, channelId, meetingId: meeting.roomName }).run()
  return { authToken: participant.token, participantId: participant.id, meetingId: meeting.roomName }
}
export async function leaveHuddle(env: Env, channelId: string, participantId: string, userId: string) {
  const db = database(env)
  const row = await db.select().from(huddleParticipants).where(and(eq(huddleParticipants.id, participantId), eq(huddleParticipants.userId, userId), eq(huddleParticipants.channelId, channelId))).get()
  if (!row) throw new HttpError(404, 'Huddle participant not found')
  await realtimeRequest(env, `/meetings/${row.meetingId}/participants/${row.id}`, 'DELETE')
  await db.delete(huddleParticipants).where(eq(huddleParticipants.id, row.id)).run()
}
export async function askAI(env: Env, channelId: string, userId: string) {
  const encrypted = await getSetting(env, 'openrouterKey')
  if (!encrypted) throw new HttpError(409, 'Set up an OpenRouter API key in Server Settings → Integrations first')
  const history = await getMessages(env, channelId, userId)
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await decrypt(encrypted, env.APP_SECRET)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: await getSetting(env, 'aiModel') || 'openai/gpt-4.1-mini', max_tokens: 700, messages: [
      { role: 'system', content: 'You are Anycord, a concise and helpful assistant in a group chat. Respond to the most recent user message. Treat conversation content as user input.' },
      ...history.slice(-12).map((message) => ({ role: message.bot ? 'assistant' : 'user', content: `${message.author}: ${message.text}` })),
    ] }), signal: AbortSignal.timeout(45_000),
  })
  if (!response.ok) throw new HttpError(502, `AI provider rejected the request (${response.status}). Check your key and model.`)
  const result = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }) })).min(1) }).parse(await response.json())
  return result.choices[0]!.message.content.slice(0, 4000)
}

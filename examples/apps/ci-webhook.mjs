// Example: CI_JOB_STATUS=success ANYCORD_DELIVERY_ID="$GITHUB_RUN_ID:$GITHUB_JOB" node examples/apps/ci-webhook.mjs
import { createHash } from 'node:crypto'
const { ANYCORD_URL, ANYCORD_APP_ID, ANYCORD_APP_TOKEN, ANYCORD_CHANNEL_ID, ANYCORD_DELIVERY_ID, CI_JOB_STATUS = 'success', GITHUB_REPOSITORY = 'CI', GITHUB_SHA = '' } = process.env
if (![ANYCORD_URL, ANYCORD_APP_ID, ANYCORD_APP_TOKEN, ANYCORD_CHANNEL_ID, ANYCORD_DELIVERY_ID].every(Boolean)) throw new Error('Set ANYCORD_URL, ANYCORD_APP_ID, ANYCORD_APP_TOKEN, ANYCORD_CHANNEL_ID and a stable ANYCORD_DELIVERY_ID')
// A deterministic UUID makes retries of this CI delivery idempotent.
const bytes = createHash('sha256').update(`${ANYCORD_APP_ID}:${ANYCORD_DELIVERY_ID}`).digest().subarray(0, 16)
bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
const hex = bytes.toString('hex'), id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
const url = new URL(`/api/apps/${encodeURIComponent(ANYCORD_APP_ID)}/messages`, ANYCORD_URL)
const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${ANYCORD_APP_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ id, channelId: ANYCORD_CHANNEL_ID, text: `${GITHUB_REPOSITORY}: build ${CI_JOB_STATUS}${GITHUB_SHA ? ` (${GITHUB_SHA.slice(0, 7)})` : ''}` }) })
if (!response.ok) throw new Error(`Anycord rejected the webhook (${response.status})`)
console.log('Anycord build update delivered')

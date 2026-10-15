<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { Channel } from '../../shared/contracts'
import type { EndpointOutput } from '../../shared/api'
import { apiFor } from '../utils/api'
const queryClient = useQueryClient()
const props = defineProps<{ workspaceId: string; appId: string; channelIds: string[]; channels: Channel[]; active: boolean }>(), api = apiFor()
const params = computed(() => ({ workspaceId: props.workspaceId, appId: props.appId }))
const hooks = useQuery({ queryKey: ['slack-webhooks', props.workspaceId, props.appId], queryFn: () => api('slackWebhooks', { params: params.value }) })
const selectedChannel = ref(''), busy = ref(false), error = ref(''), confirmRevoke = ref(''), copied = ref(false)
const credential = ref<EndpointOutput<'slackWebhookCreate'> | null>(null)
const available = computed(() => props.channels.filter(c => c.kind === 'text' && props.channelIds.includes(c.id) && !(hooks.data.value || []).some(h => h.channelId === c.id)).map(c => ({ value: c.id, label: `#${c.name}` })))
watch(available, channels => { if (!channels.some(c => c.value === selectedChannel.value)) selectedChannel.value = channels[0]?.value || '' }, { immediate: true })
watch(hooks.data, rows => { if (credential.value && rows && !rows.some(h => h.id === credential.value?.id)) credential.value = null })
async function perform(action: () => Promise<void>) {
  busy.value = true; error.value = ''; copied.value = false
  try { await action(); await Promise.all([hooks.refetch(), queryClient.invalidateQueries({ queryKey: ['app-audit', props.workspaceId] })]) } catch (cause) { error.value = apiError(cause) }
  finally { busy.value = false }
}
function create() { return perform(async () => { credential.value = await api('slackWebhookCreate', { params: params.value, body: { channelId: selectedChannel.value } }) }) }
function rotate(webhookId: string) { return perform(async () => { credential.value = await api('slackWebhookRotate', { params: { ...params.value, webhookId } }) }) }
function revoke(webhookId: string) { return perform(async () => { await api('slackWebhookRevoke', { params: { ...params.value, webhookId } }); confirmRevoke.value = '' }) }
async function copy() {
  try { if (credential.value) { await navigator.clipboard.writeText(credential.value.url); copied.value = true } }
  catch { error.value = 'Could not copy automatically. Select and copy the URL above.' }
}
</script>
<template>
  <section class="space-y-3 border-t border-default pt-3">
    <h4 class="font-semibold">Slack incoming webhooks</h4>
    <p class="text-sm">Send plain-text Slack notifications to a selected channel. Cards, attachments and thread replies are not supported yet.</p>
    <UAlert v-if="error || hooks.isError.value" color="error" :title="error || 'Could not load webhook settings'" />
    <div v-if="credential" class="space-y-2 rounded border border-default p-3">
      <UAlert color="warning" title="Save this webhook URL now" description="The URL is a secret and is only shown after creation or rotation. Anyone with it can post to its channel." />
      <UFormField label="Slack webhook URL"><UInput :model-value="credential.url" readonly class="w-full" autocomplete="off" /></UFormField>
      <div class="flex flex-wrap gap-2"><UButton color="neutral" variant="outline" @click="copy">{{ copied ? 'Copied' : 'Copy URL' }}</UButton><UButton color="neutral" variant="ghost" @click="credential = null">I saved the webhook URL</UButton></div>
    </div>
    <form v-if="available.length" class="flex flex-wrap items-end gap-2" @submit.prevent="create">
      <UFormField label="Webhook channel"><USelect v-model="selectedChannel" :items="available" :disabled="!active || busy || hooks.isPending.value" /></UFormField>
      <UButton type="submit" :loading="busy" :disabled="!active || !selectedChannel || hooks.isPending.value">Create Slack webhook</UButton>
    </form>
    <div v-for="hook in hooks.data.value || []" :key="hook.id" class="space-y-2 rounded border border-default p-3">
      <div class="flex flex-wrap items-center gap-2"><span class="min-w-0 break-all">#{{ channels.find(c => c.id === hook.channelId)?.name || hook.channelId }}</span><UButton color="neutral" variant="outline" :disabled="busy || !active" @click="rotate(hook.id)">Rotate URL</UButton><UButton color="error" variant="ghost" :disabled="busy" @click="confirmRevoke = hook.id">Revoke URL</UButton></div>
      <div v-if="confirmRevoke === hook.id" class="space-y-2"><p class="text-sm">Revoke this webhook URL? Senders using it will lose access immediately.</p><UButton color="error" :loading="busy" @click="revoke(hook.id)">Confirm revoke URL</UButton><UButton color="neutral" variant="ghost" @click="confirmRevoke = ''">Cancel</UButton></div>
    </div>
    <p class="text-xs text-muted">POST JSON with a text field to the URL; success returns “ok”. Rotation of the app's general credentials also revokes these URLs.</p>
  </section>
</template>

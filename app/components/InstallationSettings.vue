<script setup lang="ts">
const api = apiFor()
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { integrationSchema } from '../../shared/contracts'
import { apiFor } from '../utils/api'
const open = defineModel<boolean>('open', { default: false })
const owner = true
const tab = ref('authentication')
watch(open, value => { if (value) tab.value = 'authentication' })
const feedback = ref('')
const error = ref('')
const queryClient = useQueryClient()
const integrations = useQuery({ queryKey: ['integrations'], queryFn: () => api('integrations'), enabled: open })
const database = useQuery({ queryKey: ['database'], queryFn: () => api('database'), enabled: computed(() => open.value && owner && tab.value === 'database') })
const state = reactive({ realtimeAccountId: '', realtimeAppId: '', realtimePreset: 'group_call_participant', realtimeToken: '', openrouterKey: '', aiModel: 'openai/gpt-4.1-mini' })
watch(integrations.data, (data) => {
  if (!data) return
  state.realtimeAccountId = data.realtimeAccountId; state.realtimeAppId = data.realtimeAppId
  state.realtimePreset = data.realtimePreset; state.aiModel = data.aiModel
}, { immediate: true })
const save = useMutation({
  mutationFn: () => api('integrationsUpdate', { body: { ...state, realtimeToken: state.realtimeToken || undefined, openrouterKey: state.openrouterKey || undefined } }),
  onSuccess: async () => {
    state.realtimeToken = ''; state.openrouterKey = ''; feedback.value = 'Settings saved. API keys are encrypted on the server.'
    await queryClient.invalidateQueries({ queryKey: ['integrations'] })
  },
  onError: (cause) => { error.value = apiError(cause) },
})
const testAI = useMutation({ mutationFn: () => api('integrationsAiTest'), onSuccess: () => { feedback.value = 'OpenRouter responded using your saved key and model. Connection verified.' }, onError: (cause) => { error.value = apiError(cause) } })
const test = useMutation({ mutationFn: () => api('integrationsTest'), onSuccess: () => { feedback.value = 'RealtimeKit credentials and participant preset verified.' }, onError: (cause) => { error.value = apiError(cause) } })
async function submit() { error.value = ''; feedback.value = ''; await save.mutateAsync().catch(() => undefined) }
async function disconnect(provider: 'realtimeToken' | 'openrouterKey') {
  error.value = ''; feedback.value = ''
  try {
    await api('integrationsUpdate', { body: { ...state, realtimeToken: undefined, openrouterKey: undefined, [provider]: '' } })
    await queryClient.invalidateQueries({ queryKey: ['integrations'] }); feedback.value = 'API key removed.'
  } catch (cause) { error.value = apiError(cause) }
}
watch(open, (value) => { if (!value) { state.realtimeToken = ''; state.openrouterKey = ''; error.value = ''; feedback.value = '' } })
</script>
<template>
<SettingsFrame v-model:open="open" title="Installation Settings" label="INSTALLATION OWNER">
<template #navigation><button :class="{ active: tab === 'authentication' }" @click="tab = 'authentication'"><UIcon name="i-lucide-shield-check" />Authentication</button><button :class="{ active: tab === 'integrations' }" @click="tab = 'integrations'"><UIcon name="i-lucide-plug" />Integrations</button><button :class="{ active: tab === 'storage' }" @click="tab = 'storage'"><UIcon name="i-lucide-hard-drive" />File storage</button><button :class="{ active: tab === 'database' }" @click="tab = 'database'"><UIcon name="i-lucide-database" />Database</button></template>
          <AuthenticationSettings v-if="tab === 'authentication'" />
          <template v-if="tab === 'integrations'">
            <h2>Integrations</h2><p class="section-description">Connect services for every community on this installation. Credentials stay encrypted on the installation.</p>
            <UAlert v-if="integrations.isError.value" color="error" title="Could not load integration settings" />
            <UAlert v-if="!owner" color="info" title="Only the installation owner can change API credentials." />
            <UForm :state="state" :schema="integrationSchema" @submit="submit" class="integration-form">
              <div class="integration-heading"><UIcon name="i-lucide-audio-lines" /><h3>Calls &amp; huddles</h3><span :class="['connection-label', { configured: integrations.data.value?.realtimeConfigured }]">{{ integrations.data.value?.realtimeConfigured ? 'Configured' : 'Not configured' }}</span></div>
              <p>Voice, video, and screen sharing with Cloudflare RealtimeKit. Create an app and participant preset, then save your credentials and test the connection.</p>
              <div class="integration-actions flex-wrap"><UButton to="https://dash.cloudflare.com/?to=/:account/realtime/kit" target="_blank" rel="noopener noreferrer" icon="i-lucide-external-link" color="neutral" variant="outline">Set up in Cloudflare</UButton><UButton to="https://developers.cloudflare.com/realtime/realtimekit/quickstart/" target="_blank" rel="noopener noreferrer" color="neutral" variant="link">Setup guide</UButton></div>
              <div class="field-grid"><UFormField name="realtimeAccountId" label="ACCOUNT ID"><UInput v-model="state.realtimeAccountId" :disabled="!owner" class="w-full" autocomplete="off" /></UFormField><UFormField name="realtimeAppId" label="APP ID"><UInput v-model="state.realtimeAppId" :disabled="!owner" class="w-full" autocomplete="off" /></UFormField></div>
              <UFormField name="realtimeToken" label="API TOKEN" description="Use a token with Realtime permissions for this account. Leave blank to keep a saved token."><UInput v-model="state.realtimeToken" type="password" :disabled="!owner" :placeholder="integrations.data.value?.realtimeConfigured ? 'Saved token — enter a replacement' : 'Paste your Cloudflare API token'" autocomplete="new-password" class="w-full" /></UFormField>
              <UFormField name="realtimePreset" label="PARTICIPANT PRESET" description="Must match an existing participant preset in your RealtimeKit app."><UInput v-model="state.realtimePreset" :disabled="!owner" class="w-full" /></UFormField>
              <div v-if="owner" class="integration-actions flex-wrap"><UButton color="neutral" variant="outline" :disabled="!integrations.data.value?.realtimeConfigured" :loading="test.isPending.value" @click="error = ''; feedback = ''; test.mutate()">Test connection</UButton><UButton v-if="integrations.data.value?.realtimeConfigured" color="error" variant="ghost" @click="disconnect('realtimeToken')">Remove token</UButton></div>
              <hr />
              <div class="integration-heading"><UIcon name="i-lucide-bot" /><h3>AI assistant</h3><span :class="['connection-label', { configured: integrations.data.value?.aiConfigured }]">{{ integrations.data.value?.aiConfigured ? 'Configured' : 'Not configured' }}</span></div>
              <p>Connect OpenRouter to ask an assistant about the conversation. “Ask AI” sends the last 12 channel messages to your provider.</p>
              <UFormField name="openrouterKey" label="OPENROUTER API KEY"><UInput v-model="state.openrouterKey" type="password" :disabled="!owner" placeholder="Leave blank to keep a saved key" autocomplete="new-password" class="w-full" /></UFormField>
              <UFormField name="aiModel" label="MODEL ID"><UInput v-model="state.aiModel" :disabled="!owner" class="w-full" /></UFormField>
              <p v-if="owner" class="integration-test-note">Save changes before testing. The test sends a short prompt to your selected model and may use a small amount of credit. No chat messages are sent.</p>
              <div v-if="owner" class="integration-actions flex-wrap"><UButton color="neutral" variant="outline" :disabled="!integrations.data.value?.aiConfigured || save.isPending.value" :loading="testAI.isPending.value" @click="error = ''; feedback = ''; testAI.mutate()">Test AI connection</UButton><UButton v-if="integrations.data.value?.aiConfigured" color="error" variant="ghost" @click="disconnect('openrouterKey')">Remove AI key</UButton></div>
              <hr /><div class="integration-heading"><UIcon name="i-lucide-mail" /><h3>Email</h3><span class="connection-label">Later</span></div><p>Email delivery will be connected through an external provider in a later update.</p>
              <UAlert v-if="error" color="error" :title="error" /><UAlert v-if="feedback" color="success" :title="feedback" />
              <UButton v-if="owner" type="submit" :loading="save.isPending.value">Save Changes</UButton>
            </UForm>
            <div class="telegram-integration"><TelegramIntegration /></div>
          </template>
          <div v-show="tab === 'storage'"><StorageSettings v-if="owner" /></div>
          <template v-if="tab === 'database'">
            <h2>Database</h2><p class="section-description">Storage and migration history for this installation.</p>
            <UAlert v-if="database.isError.value" color="error" title="Could not load database details" />
            <template v-if="database.data.value"><dl class="db-counts"><div v-for="(value, key) in database.data.value.counts" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></div></dl><h3>Applied migrations</h3><ol class="migration-list"><li v-for="migration in database.data.value.migrations" :key="migration.name"><UIcon name="i-lucide-circle-check" /><span>{{ migration.name }}<small>{{ new Date(migration.appliedAt).toLocaleString() }}</small></span></li></ol><p class="section-description">The server applies its engine’s migrations before becoming healthy.</p><UButton color="neutral" variant="outline" @click="database.refetch()">Refresh</UButton></template>
          </template>
</SettingsFrame>
</template>

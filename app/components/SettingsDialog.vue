<script setup lang="ts">
const api = apiFor()
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { integrationSchema, type Workspace, type Channel } from '../../shared/contracts'
import { apiFor } from '../utils/api'
import type { EndpointOutput } from '../../shared/api'
const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{ owner: boolean; workspace?: Workspace; channels: Channel[]; members: EndpointOutput<'bootstrap'>['members'] }>()
const tab = ref('overview')
watch(open, value => { if (value) tab.value = 'overview' })
const feedback = ref('')
const error = ref('')
const queryClient = useQueryClient()
const integrations = useQuery({ queryKey: ['integrations'], queryFn: () => api('integrations'), enabled: open })
const database = useQuery({ queryKey: ['database'], queryFn: () => api('database'), enabled: computed(() => open.value && props.owner && tab.value === 'database') })
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
  <SettingsFrame v-model:open="open" title="Server Settings" :label="workspace?.name || 'SERVER SETTINGS'">
    <template #navigation><button :class="{ active: tab === 'overview' }" @click="tab = 'overview'"><UIcon name="i-lucide-sliders-horizontal" />Overview</button><button :class="{ active: tab === 'channels' }" @click="tab = 'channels'"><UIcon name="i-lucide-hash" />Channels</button><button :class="{ active: tab === 'members' }" @click="tab = 'members'"><UIcon name="i-lucide-users-round" />Members</button><hr /><button v-if="owner" :class="{ active: tab === 'storage' }" @click="tab = 'storage'"><UIcon name="i-lucide-hard-drive" />File storage</button><button :class="{ active: tab === 'integrations' }" @click="tab = 'integrations'"><UIcon name="i-lucide-plug" />Integrations</button><button v-if="owner" :class="{ active: tab === 'database' }" @click="tab = 'database'"><UIcon name="i-lucide-database" />Database</button></template>
          <div v-show="tab === 'overview'"><ServerOverview v-if="workspace" :key="workspace.id" :workspace="workspace" /><p v-else>Loading server settings…</p></div>
          <div v-show="tab === 'channels'"><ServerChannels :key="workspace?.id" :channels="channels" :owner="workspace?.role === 'owner'" /></div>
          <template v-if="tab === 'members'"><h2>Members — {{ members.length }}</h2><p class="section-description">People who belong to this server.</p><div class="settings-members"><div v-for="member in members" :key="member.id"><span class="avatar small" :style="{ background: member.color }">{{ member.name.slice(0, 2).toUpperCase() }}</span><strong>{{ member.name }}</strong><span>{{ member.workspaceRole === 'owner' ? 'Server owner' : 'Member' }}</span></div></div></template>
          <template v-else-if="tab === 'integrations'">
            <h2>Integrations</h2><p class="section-description">Connect the services your server uses. Credentials stay on the server.</p>
            <UAlert v-if="integrations.isError.value" color="error" title="Could not load integration settings" />
            <UAlert v-if="!owner" color="info" title="Only the installation owner can change API credentials." />
            <UForm :state="state" :schema="integrationSchema" @submit="submit" class="integration-form">
              <div class="integration-heading"><UIcon name="i-lucide-audio-lines" /><h3>Cloudflare RealtimeKit</h3><span :class="['connection-label', { configured: integrations.data.value?.realtimeConfigured }]">{{ integrations.data.value?.realtimeConfigured ? 'Configured' : 'Not configured' }}</span></div>
              <p>Voice, video, and screen sharing through your Cloudflare account. Save your credentials, then test the connection.</p>
              <div class="field-grid"><UFormField name="realtimeAccountId" label="ACCOUNT ID"><UInput v-model="state.realtimeAccountId" :disabled="!owner" class="w-full" autocomplete="off" /></UFormField><UFormField name="realtimeAppId" label="APP ID"><UInput v-model="state.realtimeAppId" :disabled="!owner" class="w-full" autocomplete="off" /></UFormField></div>
              <UFormField name="realtimeToken" label="API TOKEN" description="Use a token with Realtime permissions for this account. Leave blank to keep a saved token."><UInput v-model="state.realtimeToken" type="password" :disabled="!owner" :placeholder="integrations.data.value?.realtimeConfigured ? 'Saved token — enter a replacement' : 'Paste your Cloudflare API token'" autocomplete="new-password" class="w-full" /></UFormField>
              <UFormField name="realtimePreset" label="PARTICIPANT PRESET" description="Must match an existing participant preset in your RealtimeKit app."><UInput v-model="state.realtimePreset" :disabled="!owner" class="w-full" /></UFormField>
              <div v-if="owner" class="integration-actions"><UButton color="neutral" variant="outline" :disabled="!integrations.data.value?.realtimeConfigured" :loading="test.isPending.value" @click="error = ''; feedback = ''; test.mutate()">Test connection</UButton><UButton v-if="integrations.data.value?.realtimeConfigured" color="error" variant="ghost" @click="disconnect('realtimeToken')">Remove token</UButton></div>
              <hr />
              <div class="integration-heading"><UIcon name="i-lucide-bot" /><h3>AI assistant</h3><span :class="['connection-label', { configured: integrations.data.value?.aiConfigured }]">{{ integrations.data.value?.aiConfigured ? 'Configured' : 'Not configured' }}</span></div>
              <p>Connect OpenRouter to ask an assistant about the conversation. “Ask AI” sends the last 12 channel messages to your provider.</p>
              <UFormField name="openrouterKey" label="OPENROUTER API KEY"><UInput v-model="state.openrouterKey" type="password" :disabled="!owner" placeholder="Leave blank to keep a saved key" autocomplete="new-password" class="w-full" /></UFormField>
              <UFormField name="aiModel" label="MODEL ID"><UInput v-model="state.aiModel" :disabled="!owner" class="w-full" /></UFormField>
              <UButton v-if="owner && integrations.data.value?.aiConfigured" color="error" variant="ghost" @click="disconnect('openrouterKey')">Remove AI key</UButton>
              <hr /><div class="integration-heading"><UIcon name="i-lucide-mail" /><h3>Email</h3><span class="connection-label">Later</span></div><p>Email delivery will be connected through an external provider in a later update.</p>
              <UAlert v-if="error" color="error" :title="error" /><UAlert v-if="feedback" color="success" :title="feedback" />
              <UButton v-if="owner" type="submit" :loading="save.isPending.value">Save Changes</UButton>
            </UForm>
          </template>
          <div v-show="tab === 'storage'"><StorageSettings v-if="owner" /></div>
          <template v-if="tab === 'database'">
            <h2>Database</h2><p class="section-description">Storage and migration history for this installation.</p>
            <UAlert v-if="database.isError.value" color="error" title="Could not load database details" />
            <template v-if="database.data.value"><dl class="db-counts"><div v-for="(value, key) in database.data.value.counts" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></div></dl><h3>Applied migrations</h3><ol class="migration-list"><li v-for="migration in database.data.value.migrations" :key="migration.name"><UIcon name="i-lucide-circle-check" /><span>{{ migration.name }}<small>{{ new Date(migration.appliedAt).toLocaleString() }}</small></span></li></ol><p class="section-description">The server applies its engine’s migrations before becoming healthy.</p><UButton color="neutral" variant="outline" @click="database.refetch()">Refresh</UButton></template>
          </template>
  </SettingsFrame>
</template>

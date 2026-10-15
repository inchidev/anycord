<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { appConfigSchema, type AppConfig } from '../../shared/apps'
import type { Channel } from '../../shared/contracts'
import type { EndpointOutput } from '../../shared/api'
import { apiFor } from '../utils/api'
const queryClient = useQueryClient()
const props = defineProps<{ workspaceId: string; channels: Channel[] }>(), api = apiFor()
const apps = useQuery({ queryKey: ['server-apps', props.workspaceId], queryFn: () => api('serverApps', { params: { workspaceId: props.workspaceId } }) })
const audit = useQuery({ queryKey: ['app-audit', props.workspaceId], queryFn: () => api('appAudit', { params: { workspaceId: props.workspaceId } }) })
const deliveries = useQuery({ queryKey: ['app-deliveries', props.workspaceId], queryFn: () => api('appDeliveries', { params: { workspaceId: props.workspaceId } }) })
const empty = (): AppConfig => ({ name: '', avatarUrl: '', kind: 'webhook', channelIds: [], enabled: true, endpointUrl: '', events: [], commands: [] })
const state = reactive<AppConfig>(empty()), editing = ref<string | null>(null), formOpen = ref(false), busy = ref(false), error = ref(''), confirmDelete = ref('')
const credentials = ref<EndpointOutput<'appInstall'> | null>(null)
function edit(app?: EndpointOutput<'serverApps'>['apps'][number]) {
  credentials.value = null; error.value = ''; confirmDelete.value = ''; editing.value = app?.id || null
  Object.assign(state, app ? structuredClone(appConfigSchema.parse(app)) : empty()); formOpen.value = true
}
watch(() => state.kind, kind => { if (kind === 'ping') { state.endpointUrl = ''; state.events = []; state.commands = [] } })
async function refresh() { await Promise.all([apps.refetch(), audit.refetch(), deliveries.refetch(), queryClient.invalidateQueries({ queryKey: ['commands', props.workspaceId] }), queryClient.invalidateQueries({ queryKey: ['slack-webhooks', props.workspaceId] })]) }
async function perform(action: () => Promise<void>) {
  busy.value = true; error.value = ''
  try { await action(); await refresh() } catch (cause) { error.value = apiError(cause) }
  finally { busy.value = false }
}
async function save() {
  await perform(async () => {
    const body = appConfigSchema.parse(state)
    if (editing.value) await api('appUpdate', { params: { workspaceId: props.workspaceId, appId: editing.value }, body })
    else credentials.value = await api('appInstall', { params: { workspaceId: props.workspaceId }, body })
    formOpen.value = false
  })
}
function rotate(appId: string) { return perform(async () => { credentials.value = await api('appRotate', { params: { workspaceId: props.workspaceId, appId } }) }) }
function toggle(app: EndpointOutput<'serverApps'>['apps'][number]) { return perform(async () => { await api('appUpdate', { params: { workspaceId: props.workspaceId, appId: app.id }, body: { ...appConfigSchema.parse(app), enabled: !app.enabled } }) }) }
function uninstall(appId: string) { return perform(async () => { await api('appUninstall', { params: { workspaceId: props.workspaceId, appId } }); credentials.value = null; confirmDelete.value = '' }) }
function channel(id: string) { return props.channels.find(c => c.id === id)?.name || id }
</script>
<template>
  <section class="space-y-5">
    <h2>Apps &amp; integrations</h2>
    <p class="section-description">Give a bot permission to post in selected channels. Outbound subscriptions share new human messages; bots cannot read history, manage members or trigger other apps.</p>
    <UAlert v-if="apps.isError.value" color="error" title="Could not load apps" />
    <UAlert v-if="apps.data.value && !apps.data.value.policy.enabled" color="warning" title="Apps are blocked by installation policy" description="The installation owner can enable them in User Settings → Installation Settings → Integrations." />
    <UAlert v-if="error" color="error" :title="error" />
    <div v-if="credentials" class="space-y-3 rounded-lg border border-default p-4">
      <UAlert color="warning" title="Save these secrets now" description="They are only shown after install or rotation. Rotation revokes the previous token, signing key and Slack webhook URLs, and cancels pending deliveries." />
      <UFormField label="App token"><UInput :model-value="credentials.token" readonly class="w-full" autocomplete="off" /></UFormField>
      <UFormField label="Event signing secret"><UInput :model-value="credentials.signingSecret" readonly class="w-full" autocomplete="off" /></UFormField>
      <p class="break-all">POST /api/apps/{{ credentials.app.id }}/messages with Authorization: Bearer &lt;app token&gt;.</p>
      <UButton color="neutral" variant="outline" @click="credentials = null">I saved the secrets</UButton>
    </div>
    <UButton v-if="!formOpen" icon="i-lucide-plus" :disabled="!apps.data.value?.policy.enabled || busy" @click="edit()">Install app</UButton>
    <UForm v-if="formOpen" :state="state" :schema="appConfigSchema" class="space-y-4 rounded-lg border border-default p-4" @submit="save">
      <h3>{{ editing ? 'Configure app' : 'Install app' }}</h3>
      <UFormField name="kind" label="App type"><USelect v-model="state.kind" :disabled="!!editing" :items="[{ value: 'webhook', label: 'Incoming webhook / external bot' }, { value: 'ping', label: 'Ping example bot' }]" class="w-full" /></UFormField>
      <UFormField name="name" label="Bot name"><UInput v-model="state.name" class="w-full" /></UFormField>
      <UFormField name="avatarUrl" label="Avatar URL (optional)"><UInput v-model="state.avatarUrl" placeholder="https://example.com/bot.png" class="w-full" /></UFormField>
      <UFormField name="channelIds" label="Authorized text channels" description="This is the complete channel grant, for both posting and outbound events.">
        <UCheckboxGroup v-model="state.channelIds" :items="channels.filter(c => c.kind === 'text').map(c => ({ value: c.id, label: `#${c.name}` }))" />
      </UFormField>
      <UCheckbox v-model="state.enabled" label="App enabled" />
      <p v-if="state.kind === 'ping'">Members can run /ping in these channels to receive “Pong!” from this bot.</p>
      <template v-else>
        <UFormField name="endpointUrl" label="Outbound event endpoint (optional)" :description="`Approved origins: ${apps.data.value?.policy.allowedOrigins.join(', ') || 'none; ask the installation owner'}`"><UInput v-model="state.endpointUrl" placeholder="https://hooks.example.com/anycord" class="w-full" /></UFormField>
        <UCheckbox :model-value="state.events.includes('message.created')" label="Share new human messages with this endpoint" @update:model-value="value => state.events = value ? ['message.created'] : []" />
        <h3>Slash commands</h3>
        <p>Commands send their validated arguments and member ID to the endpoint. Return a JSON object with a text field to respond as the bot.</p>
        <div v-for="(command, index) in state.commands" :key="index" class="space-y-3 rounded border border-default p-3">
          <UFormField :name="`commands.${index}.name`" label="Command name"><UInput v-model="command.name" placeholder="echo" /></UFormField>
          <UFormField :name="`commands.${index}.description`" label="Description"><UInput v-model="command.description" class="w-full" /></UFormField>
          <div v-for="(arg, argIndex) in command.arguments" :key="argIndex" class="flex flex-wrap items-end gap-2">
            <UFormField :name="`commands.${index}.arguments.${argIndex}.name`" label="Argument"><UInput v-model="arg.name" placeholder="text" /></UFormField>
            <UFormField label="Type"><USelect v-model="arg.type" :items="['string', 'integer', 'boolean']" /></UFormField>
            <UCheckbox v-model="arg.required" label="Required" /><UButton color="error" variant="ghost" :aria-label="`Remove argument ${arg.name}`" @click="command.arguments.splice(argIndex, 1)">Remove</UButton>
          </div>
          <div class="flex flex-wrap gap-2"><UButton color="neutral" variant="outline" :disabled="command.arguments.length >= 10" @click="command.arguments.push({ name: '', type: 'string', required: false })">Add argument</UButton><UButton color="error" variant="ghost" @click="state.commands.splice(index, 1)">Remove command</UButton></div>
        </div>
        <UButton color="neutral" variant="outline" :disabled="state.commands.length >= 20" @click="state.commands.push({ name: '', description: '', arguments: [] })">Add command</UButton>
      </template>
      <UAlert color="info" title="Permissions" :description="`Post messages in ${state.channelIds.length} channels${state.events.length ? '; share new human messages with the endpoint' : ''}${state.kind === 'ping' || state.commands.length ? '; respond to explicit member commands' : ''}. No access to history or member administration.`" />
      <div class="flex gap-2"><UButton type="submit" :loading="busy">{{ editing ? 'Save changes' : 'Install app' }}</UButton><UButton color="neutral" variant="ghost" :disabled="busy" @click="formOpen = false">Cancel</UButton></div>
    </UForm>
    <p v-if="!apps.isPending.value && !apps.data.value?.apps.length">No apps installed yet. Install Ping to try /ping, or create an incoming webhook for CI updates.</p>
    <article v-for="app in apps.data.value?.apps || []" :key="app.id" class="space-y-3 rounded-lg border border-default p-4">
      <div class="flex flex-wrap items-center gap-2"><UserAvatar :name="app.name" :avatar-url="app.avatarUrl || null" color="#8b5cf6" /><h3>{{ app.name }}</h3><UBadge color="neutral" variant="subtle">APP</UBadge><UBadge :color="app.status === 'active' ? 'success' : 'warning'">{{ app.status }}</UBadge></div>
      <p>{{ app.permissions.join(' · ') }}</p><p>Channels: {{ app.channelIds.map(id => `#${channel(id)}`).join(', ') }}</p>
      <p v-if="app.endpointUrl" class="break-all">Events: {{ app.endpointUrl }}</p>
      <div class="flex flex-wrap gap-2"><UButton color="neutral" variant="outline" :disabled="busy" @click="edit(app)">Configure</UButton><UButton color="neutral" variant="outline" :disabled="busy" @click="toggle(app)">{{ app.enabled ? 'Disable' : 'Enable' }}</UButton><UButton color="neutral" variant="outline" :disabled="busy" @click="rotate(app.id)">Rotate credentials</UButton><UButton color="error" variant="ghost" :disabled="busy" @click="confirmDelete = app.id">Uninstall</UButton></div>
      <SlackWebhookSettings :workspace-id="workspaceId" :app-id="app.id" :channel-ids="app.channelIds" :channels="channels" :active="app.status === 'active'" />
      <div v-if="confirmDelete === app.id" class="space-y-2"><p>Uninstall {{ app.name }}? Its credentials and pending deliveries will be revoked. Its existing messages stay visible.</p><UButton color="error" :loading="busy" @click="uninstall(app.id)">Confirm uninstall</UButton><UButton color="neutral" variant="ghost" @click="confirmDelete = ''">Cancel</UButton></div>
    </article>
    <div class="flex items-center justify-between"><h3>Recent activity</h3><UButton color="neutral" variant="ghost" :loading="busy" @click="refresh">Refresh</UButton></div>
    <UAlert v-if="audit.isError.value || deliveries.isError.value" color="error" title="Could not load app activity" />
    <ul class="space-y-2 text-sm"><li v-for="event in audit.data.value?.slice(0, 12) || []" :key="event.id">{{ event.action }} · {{ new Date(event.createdAt).toLocaleString() }}</li></ul>
    <h3>Event deliveries</h3>
    <p class="text-sm">Pending events retry up to five times. Failed and cancelled commands show an error to their caller.</p>
    <ul class="space-y-2 text-sm"><li v-for="event in deliveries.data.value?.slice(0, 12) || []" :key="event.id">{{ event.type }} · {{ event.status }} · {{ event.attempts }} attempts<span v-if="event.lastError"> · {{ event.lastError }}</span></li></ul>
  </section>
</template>

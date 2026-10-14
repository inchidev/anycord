<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { apiFor } from '../utils/api'
import { connectionOrigin } from '../utils/connection'
import { serverPath } from '../../shared/navigation'
const { $connections: connections } = useNuxtApp()
const client = useQueryClient(), api = apiFor(), location = window.location
const auth = useQuery({ queryKey: ['auth'], queryFn: () => api('authStatus'), retry: false, enabled: connections.open })
const canCreate = computed(() => !auth.isError.value && auth.data.value?.user?.role === 'owner')
const origin = ref(''), name = ref(''), remoteName = ref(''), error = ref(''), pending = ref(false)
const renameId = ref<string>(), alias = ref('')
const title = computed(() => ({ manage: 'Your connections', choose: canCreate.value ? 'Add a server' : 'Connect an installation', create: 'Create a server', remote: 'Connect an installation' })[connections.view.value])
const description = computed(() => ({ manage: 'Your accounts and servers, grouped by installation.', choose: canCreate.value ? 'Start a community here or connect to another installation.' : 'Connect to another independent installation.', create: `Create a community on ${connections.label.value}.`, remote: 'Sign in separately on each installation you connect.' })[connections.view.value])
let generation = 0
watch([connections.open, connections.view], () => { generation++; pending.value = false; error.value = ''; renameId.value = undefined })
onBeforeUnmount(() => { generation++ })
function changeView(view: 'manage' | 'choose' | 'create' | 'remote') { connections.view.value = view }
async function connect() {
  const operation = ++generation
  pending.value = true; error.value = ''
  try {
    const url = connectionOrigin(origin.value)
    await apiFor({ origin: url === location.origin ? '' : url, token: '' })('runtime')
    if (operation !== generation || !connections.open.value) return
    connections.open.value = false
    connections.add(url, remoteName.value)
    await navigateTo('/servers')
  } catch (cause) { if (operation === generation) error.value = apiError(cause) }
  finally { if (operation === generation) pending.value = false }
}
async function create() {
  if (!canCreate.value) { error.value = 'Only the installation owner can create servers'; return }
  const operation = ++generation
  pending.value = true; error.value = ''
  try {
    const result = await api('workspaceCreate', { body: { name: name.value.trim() } })
    await client.invalidateQueries({ queryKey: ['server-picker'] })
    if (operation !== generation || !connections.open.value) return
    connections.open.value = false; name.value = ''
    await navigateTo(serverPath(result.id))
  } catch (cause) { if (operation === generation) error.value = apiError(cause) }
  finally { if (operation === generation) pending.value = false }
}
async function select(id: string) { connections.open.value = false; connections.select(id); await navigateTo('/servers') }
async function forget(id: string) { const active = connections.active.value === id; if (active) connections.open.value = false; connections.remove(id); if (active) await navigateTo('/servers') }
function editName(id: string, value: string) { renameId.value = id; alias.value = value }
function saveName() { if (renameId.value) connections.rename(renameId.value, alias.value); renameId.value = undefined }
</script>
<template>
  <UModal v-model:open="connections.open.value" :title="title" :description="description"><template #body>
    <div v-if="connections.view.value === 'choose'" class="connection-actions">
      <button v-if="canCreate" @click="changeView('create')"><UIcon name="i-lucide-plus" /><span><strong>Create a server</strong><small>On {{ connections.label.value }}</small></span><UIcon name="i-lucide-chevron-right" /></button>
      <button @click="changeView('remote')"><UIcon name="i-lucide-globe" /><span><strong>Connect another installation</strong><small>Bring its servers into this client</small></span><UIcon name="i-lucide-chevron-right" /></button>
    </div>
    <template v-else-if="connections.view.value === 'manage'">
      <div class="connection-list">
        <div><button class="connection-select" @click="select('local')"><UIcon name="i-lucide-house" /><span>{{ connections.localName.value || connections.nativeName }}<small>{{ location.host }}</small></span><UIcon v-if="connections.active.value === 'local'" name="i-lucide-check" /></button><UButton color="neutral" variant="ghost" icon="i-lucide-pencil" aria-label="Rename this installation on this device" @click="editName('local', connections.localName.value)" /></div>
        <div v-for="item in connections.entries" :key="item.id"><button class="connection-select" @click="select(item.id)"><UIcon name="i-lucide-globe" /><span>{{ item.name }}<small>{{ item.origin }}</small></span><UIcon v-if="connections.active.value === item.id" name="i-lucide-check" /></button><UButton color="neutral" variant="ghost" icon="i-lucide-pencil" :aria-label="`Rename ${item.name} on this device`" @click="editName(item.id, item.name)" /><UButton color="neutral" variant="ghost" icon="i-lucide-x" :aria-label="`Forget ${item.name}`" @click="forget(item.id)" /></div>
      </div>
      <form v-if="renameId" class="dialog-form connection-rename" @submit.prevent="saveName"><UFormField label="NAME ON THIS DEVICE" description="Only you see this name, in this browser. Leave blank to use the address."><UInput v-model="alias" :maxlength="50" autofocus class="w-full" /></UFormField><div class="flex gap-2"><UButton type="submit">Save name</UButton><UButton color="neutral" variant="ghost" @click="renameId = undefined">Cancel</UButton></div></form>
      <UButton v-else class="w-full" icon="i-lucide-plus" @click="changeView(canCreate ? 'choose' : 'remote')">{{ canCreate ? 'Add a server or installation' : 'Connect another installation' }}</UButton>
      <div class="connection-explainer"><h3>One installation, several servers</h3><p>Each address has its own accounts and files. Sign in there to see the servers you belong to. Other servers stay private.</p><p>{{ canCreate ? 'Use + to create a server here or connect another installation.' : 'Only the installation owner can create servers here. You can connect to another installation.' }} Switching installations changes your account and server list.</p></div>
    </template>
    <template v-else>
      <template v-if="connections.view.value === 'create'"><form v-if="canCreate" class="dialog-form" @submit.prevent="create"><UFormField label="SERVER NAME"><UInput v-model="name" required :minlength="2" :maxlength="50" autofocus class="w-full" placeholder="Your community" /></UFormField><UAlert v-if="error" color="error" :title="error" /><UButton type="submit" :loading="pending">Create server</UButton></form><UAlert v-else color="info" title="Only the installation owner can create servers" /></template>
      <form v-else class="dialog-form" @submit.prevent="connect"><UFormField label="INSTALLATION ADDRESS" description="Enter its base address, without a server or channel path."><UInput v-model="origin" type="url" placeholder="https://chat.example.com" required autofocus class="w-full" /></UFormField><UFormField label="NAME ON THIS DEVICE" description="Optional. Only you see this name in this browser."><UInput v-model="remoteName" :maxlength="50" placeholder="Friends, work, or your own name" class="w-full" /></UFormField><UAlert v-if="error" color="error" :title="error" /><UButton type="submit" :loading="pending" icon="i-lucide-globe">Connect</UButton></form>
      <UButton class="mt-4" color="neutral" variant="ghost" icon="i-lucide-arrow-left" @click="changeView('choose')">Back</UButton>
    </template>
  </template></UModal>
</template>

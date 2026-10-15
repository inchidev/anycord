<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { type Channel, type Member } from '../../shared/contracts'
import { everyoneRoleId, type PermissionOverride, type PermissionKey } from '../../shared/permissions'
const props = defineProps<{ channel: Channel; members: Member[] }>()
const api = apiFor(), client = useQueryClient(), busy = ref(false), error = ref(''), feedback = ref('')
const access = useQuery({ queryKey: ['permissions', props.channel.workspaceId], queryFn: () => api('permissions', { params: { workspaceId: props.channel.workspaceId } }) })
const query = useQuery({ queryKey: ['channel-permissions', props.channel.id], queryFn: () => api('channelPermissions', { params: { channelId: props.channel.id } }) })
const overrides = ref<PermissionOverride[]>([]), subject = ref(`role:${everyoneRoleId(props.channel.workspaceId)}`)
watch(() => query.data.value, data => { if (data) overrides.value = data.overrides.map(item => ({ ...item })) }, { immediate: true })
const subjects = computed(() => [
  ...(access.data.value?.roles || []).map(role => ({ label: role.name, value: `role:${role.id}` })),
  ...props.members.map(member => ({ label: `Member: ${member.name}`, value: `member:${member.id}` })),
])
const definitions = computed(() => access.data.value?.definitions.filter(item => item.scopes.includes('channel')) || [])
function target() { const separator = subject.value.indexOf(':'); return { subjectType: subject.value.slice(0, separator) as 'role' | 'member', subjectId: subject.value.slice(separator + 1) } }
function value(key: string) { const current = target(); return overrides.value.find(item => item.subjectType === current.subjectType && item.subjectId === current.subjectId && item.permission === key)?.effect || 'inherit' }
function set(key: string, effect: string) {
  const current = target()
  overrides.value = overrides.value.filter(item => !(item.subjectType === current.subjectType && item.subjectId === current.subjectId && item.permission === key))
  if (effect === 'allow' || effect === 'deny') overrides.value.push({ ...current, permission: key, effect })
}
const choices = [{ label: 'Inherit', value: 'inherit' }, { label: 'Allow', value: 'allow' }, { label: 'Deny', value: 'deny' }]
async function save() {
  busy.value = true; error.value = ''; feedback.value = ''
  try {
    await api('channelPermissionsUpdate', { params: { channelId: props.channel.id }, body: { overrides: overrides.value.map(item => ({ ...item, permission: item.permission as PermissionKey })) } })
    await Promise.all([client.invalidateQueries({ queryKey: ['bootstrap'] }), client.invalidateQueries({ queryKey: ['channel-permissions', props.channel.id] })]); feedback.value = 'Channel permissions saved.'
  } catch (cause) { error.value = apiError(cause) } finally { busy.value = false }
}
</script>

<template>
  <section class="mt-8 space-y-5">
    <h3>Channel permissions</h3><p class="section-description">Override @everyone, a role or a member. Deny View channel for @everyone and allow it for a role to make this channel private. Changing access ends active huddles in this server; members can rejoin with their updated permissions.</p>
    <UAlert v-if="query.isError.value" color="error" :title="apiError(query.error.value)" />
    <UFormField label="ROLE OR MEMBER"><USelect v-model="subject" :items="subjects" class="w-full" :disabled="busy" /></UFormField>
    <div v-if="query.data.value" class="space-y-4"><div v-for="definition in definitions" :key="definition.key" class="flex flex-wrap items-center justify-between gap-3"><div><strong>{{ definition.label }}</strong><p class="text-sm text-muted">{{ definition.description }}</p></div><USelect :model-value="value(definition.key)" :items="choices" :aria-label="`${definition.label} override`" :disabled="busy" @update:model-value="set(definition.key, String($event))" /></div></div>
    <UAlert v-if="error" color="error" :title="error" /><p v-if="feedback" role="status">{{ feedback }}</p>
    <UButton v-if="query.data.value" :loading="busy" @click="save">Save channel permissions</UButton>
  </section>
</template>

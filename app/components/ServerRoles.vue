<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { roleInputSchema, type Workspace } from '../../shared/contracts'
import { everyoneRoleId, type PermissionKey, isPermissionKey } from '../../shared/permissions'
const props = defineProps<{ workspace: Workspace }>()
const api = apiFor(), client = useQueryClient(), error = ref(''), feedback = ref(''), busy = ref(false)
const access = useQuery({ queryKey: ['permissions', props.workspace.id], queryFn: () => api('permissions', { params: { workspaceId: props.workspace.id } }) })
const selected = ref(''), creating = ref(false)
const state = reactive({ name: '', color: '#949ba4', position: 1, permissions: [] as PermissionKey[] })
const roles = computed(() => [...(access.data.value?.roles || [])].sort((a, b) => b.position - a.position))
const current = computed(() => roles.value.find(role => role.id === selected.value))
const editable = computed(() => !!access.data.value && (access.data.value.owner || (access.data.value.permissions.includes('roles.manage') && (creating.value || (!!current.value && current.value.id !== everyoneRoleId(props.workspace.id) && current.value.position < access.data.value.highestRolePosition)))))
const definitions = computed(() => access.data.value?.definitions || [])
function choose(id: string) {
  creating.value = false; selected.value = id; error.value = ''; feedback.value = ''
  const role = roles.value.find(item => item.id === id)
  if (role) Object.assign(state, { name: role.name, color: role.color, position: role.position, permissions: [...role.permissions] })
}
watch(() => access.data.value, data => { if (!selected.value && !creating.value && data?.roles.length) choose(data.roles[0]!.id) })
function create() { selected.value = ''; creating.value = true; error.value = ''; feedback.value = ''; Object.assign(state, { name: '', color: '#949ba4', position: 1, permissions: [] }) }
function toggle(key: string, value: boolean | 'indeterminate') { if (!isPermissionKey(key)) return; state.permissions = value === true ? [...new Set([...state.permissions, key])] : state.permissions.filter(item => item !== key) }
async function refresh() { await Promise.all([client.invalidateQueries({ queryKey: ['permissions', props.workspace.id] }), client.invalidateQueries({ queryKey: ['bootstrap'] })]) }
async function save() {
  busy.value = true; error.value = ''; feedback.value = ''
  try {
    const body = roleInputSchema.parse(state)
    const role = creating.value ? await api('roleCreate', { params: { workspaceId: props.workspace.id }, body }) : await api('roleUpdate', { params: { workspaceId: props.workspace.id, roleId: selected.value }, body })
    await refresh(); choose(role.id); feedback.value = 'Role saved.'
  } catch (cause) { error.value = apiError(cause) } finally { busy.value = false }
}
const deleting = ref(false)
async function remove() {
  busy.value = true; error.value = ''
  try { await api('roleDelete', { params: { workspaceId: props.workspace.id, roleId: selected.value } }); selected.value = ''; deleting.value = false; await refresh(); feedback.value = 'Role deleted.' }
  catch (cause) { error.value = apiError(cause) } finally { busy.value = false }
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center justify-between gap-3"><h2>Roles</h2><UButton v-if="access.data.value?.owner || access.data.value?.permissions.includes('roles.manage')" icon="i-lucide-plus" :disabled="busy" @click="create">Create role</UButton></div>
    <p class="section-description">Give members several roles. Higher roles can manage lower roles within their own permissions. @everyone applies to every member.</p>
    <UAlert v-if="access.isError.value" color="error" :title="apiError(access.error.value)" />
    <p v-if="access.isPending.value" role="status">Loading roles…</p>
    <div class="flex flex-wrap gap-2" aria-label="Choose a role"><UButton v-for="role in roles" :key="role.id" color="neutral" :variant="selected === role.id ? 'solid' : 'outline'" :aria-pressed="selected === role.id" :disabled="busy" @click="choose(role.id)"><span class="size-3 shrink-0 rounded-full" :style="{ backgroundColor: role.color }" />{{ role.name }}</UButton></div>
    <UForm v-if="current || creating" :schema="roleInputSchema" :state="state" class="space-y-5" @submit="save">
      <div class="grid gap-4 sm:grid-cols-2"><UFormField name="name" label="ROLE NAME"><UInput v-model="state.name" class="w-full" :disabled="!editable || busy || selected === everyoneRoleId(workspace.id)" /></UFormField><UFormField name="color" label="ROLE COLOR" description="Hex color, for example #5865f2."><UInput v-model="state.color" class="w-full" :disabled="!editable || busy" /></UFormField></div>
      <UFormField name="position" label="POSITION" description="Larger numbers are higher. Equal positions cannot manage each other."><UInput v-model.number="state.position" type="number" :min="selected === everyoneRoleId(workspace.id) ? 0 : 1" :max="access.data.value?.owner ? 10000 : (access.data.value?.highestRolePosition || 1) - 1" :disabled="!editable || busy || selected === everyoneRoleId(workspace.id)" /></UFormField>
      <h3>Permissions</h3>
      <div class="space-y-4"><UCheckbox v-for="definition in definitions" :key="definition.key" :model-value="state.permissions.some(key => key === definition.key)" :label="definition.label" :description="definition.description" :disabled="!editable || busy || (!access.data.value?.owner && !access.data.value?.permissions.includes(definition.key))" @update:model-value="toggle(definition.key, $event)" /></div>
      <UAlert v-if="error" color="error" :title="error" /><p v-if="feedback" role="status">{{ feedback }}</p>
      <div v-if="editable" class="flex flex-wrap gap-3"><UButton type="submit" :loading="busy">Save role</UButton><UButton v-if="current && selected !== everyoneRoleId(workspace.id)" color="error" variant="outline" :disabled="busy" @click="deleting = true">Delete role</UButton></div>
    </UForm>
    <UModal v-model:open="deleting" title="Delete this role?" description="The role will be removed from all members and channel overrides."><template #body><UAlert v-if="error" color="error" :title="error" /><div class="flex justify-end gap-3"><UButton color="neutral" variant="outline" :disabled="busy" @click="deleting = false">Cancel</UButton><UButton color="error" :loading="busy" @click="remove">Delete role</UButton></div></template></UModal>
  </div>
</template>

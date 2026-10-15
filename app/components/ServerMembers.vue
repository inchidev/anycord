<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { can } from '../../shared/permissions'
import type { Workspace, Member } from '../../shared/contracts'
import { apiFor } from '../utils/api'
const props = defineProps<{ workspace: Workspace; members: Member[] }>()
const api = apiFor(), client = useQueryClient(), busy = ref(false), error = ref('')
const access = useQuery({ queryKey: ['permissions', props.workspace.id], queryFn: () => api('permissions', { params: { workspaceId: props.workspace.id } }) })
const editing = ref<Member>(), assigned = ref<string[]>([])
function lower(member: Member) { return member.workspaceRole !== 'owner' && !!access.data.value && (access.data.value.owner || (member.highestRolePosition || 0) < access.data.value.highestRolePosition) }
const assignableRoles = computed(() => access.data.value?.roles.filter(role => role.position > 0 && (access.data.value?.owner || role.position < access.data.value!.highestRolePosition)) || [])
async function saveRoles() {
  if (!editing.value) return
  busy.value = true; error.value = ''
  try { await api('memberRolesUpdate', { params: { workspaceId: props.workspace.id, userId: editing.value.id }, body: { roleIds: assigned.value } }); editing.value = undefined; await client.invalidateQueries({ queryKey: ['bootstrap'] }) }
  catch (cause) { error.value = apiError(cause) } finally { busy.value = false }
}
const selected = ref<Member>(), action = ref<'remove' | 'ban'>('remove'), confirmOpen = ref(false)
const bans = useQuery({ queryKey: ['bans', props.workspace.id], queryFn: () => api('bans', { params: { workspaceId: props.workspace.id } }), enabled: computed(() => can(props.workspace, 'members.ban')) })
function choose(member: Member, kind: 'remove' | 'ban') { selected.value = member; action.value = kind; confirmOpen.value = true }
async function confirm() {
  if (!selected.value) return
  busy.value = true; error.value = ''
  try {
    await api(action.value === 'ban' ? 'memberBan' : 'memberRemove', { params: { workspaceId: props.workspace.id, userId: selected.value.id } })
    confirmOpen.value = false; await client.invalidateQueries({ queryKey: ['bootstrap'] }); await bans.refetch()
  } catch (cause) { error.value = apiError(cause) } finally { busy.value = false }
}
async function unban(userId: string) {
  busy.value = true; error.value = ''
  try { await api('memberUnban', { params: { workspaceId: props.workspace.id, userId } }); await bans.refetch() }
  catch (cause) { error.value = apiError(cause) } finally { busy.value = false }
}
</script>
<template>
  <div class="space-y-5"><h2>Members — {{ members.length }}</h2><p class="section-description">Removing a member ends access to this server. A ban also prevents joining again through an invitation.</p>
    <UAlert v-if="error" color="error" :title="error" />
    <div v-for="member in members" :key="member.id" class="flex flex-wrap items-center gap-3 rounded-lg bg-elevated p-3"><UserAvatar class="small" :name="member.name" :color="member.color" :src="member.avatarUrl" /><strong class="grow">{{ member.name }}</strong><span class="text-muted">{{ member.workspaceRole === 'owner' ? 'Server owner' : 'Member' }}</span><template v-if="lower(member)"><UButton v-if="can(workspace, 'members.remove')" color="neutral" variant="outline" :disabled="busy" @click="choose(member, 'remove')">Remove</UButton><UButton v-if="can(workspace, 'members.ban')" color="error" variant="ghost" :disabled="busy" @click="choose(member, 'ban')">Ban</UButton><UButton v-if="can(workspace, 'roles.manage')" color="neutral" variant="outline" :disabled="busy" @click="editing = member; assigned = [...(member.roleIds || [])]">Edit roles</UButton></template><div class="flex flex-wrap gap-2"><UBadge v-for="roleId in member.roleIds" :key="roleId" color="neutral" variant="subtle">{{ access.data.value?.roles.find(role => role.id === roleId)?.name }}</UBadge></div></div>
    <template v-if="can(workspace, 'members.ban')"><h3>Banned members</h3><UAlert v-if="bans.isError.value" color="error" title="Could not load bans" /><p v-else-if="!bans.data.value?.length" class="text-muted">No bans.</p><div v-for="member in bans.data.value" :key="member.id" class="flex items-center justify-between gap-3"><span>{{ member.name }}</span><UButton color="neutral" variant="outline" :disabled="busy" @click="unban(member.id)">Remove ban</UButton></div></template>
    <UModal :open="!!editing" title="Member roles" :description="editing?.name" @update:open="!$event && (editing = undefined)"><template #body><div class="space-y-4"><UCheckbox v-for="role in assignableRoles" :key="role.id" :label="role.name" :model-value="assigned.includes(role.id)" :disabled="busy" @update:model-value="assigned = $event === true ? [...new Set([...assigned, role.id])] : assigned.filter(id => id !== role.id)" /><UAlert v-if="error" color="error" :title="error" /><UButton :loading="busy" @click="saveRoles">Save member roles</UButton></div></template></UModal>
    <UModal v-model:open="confirmOpen" :title="`${action === 'ban' ? 'Ban' : 'Remove'} ${selected?.name || 'member'}?`" :description="action === 'ban' ? 'They lose access and cannot rejoin until you remove their ban.' : 'They lose access, but can rejoin with a valid invitation.'"><template #body><UAlert v-if="error" color="error" :title="error" /><div class="flex justify-end gap-3"><UButton color="neutral" variant="outline" :disabled="busy" @click="confirmOpen = false">Cancel</UButton><UButton color="error" :loading="busy" @click="confirm">{{ action === 'ban' ? 'Ban member' : 'Remove member' }}</UButton></div></template></UModal>
  </div>
</template>

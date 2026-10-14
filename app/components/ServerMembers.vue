<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { Workspace, Member } from '../../shared/contracts'
import { apiFor } from '../utils/api'
const props = defineProps<{ workspace: Workspace; members: Member[] }>()
const api = apiFor(), client = useQueryClient(), busy = ref(false), error = ref('')
const selected = ref<Member>(), action = ref<'remove' | 'ban'>('remove'), confirmOpen = ref(false)
const bans = useQuery({ queryKey: ['bans', props.workspace.id], queryFn: () => api('bans', { params: { workspaceId: props.workspace.id } }), enabled: computed(() => props.workspace.role === 'owner') })
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
    <div v-for="member in members" :key="member.id" class="flex flex-wrap items-center gap-3 rounded-lg bg-elevated p-3"><span class="avatar small" :style="{ background: member.color }">{{ member.name.slice(0, 2).toUpperCase() }}</span><strong class="grow">{{ member.name }}</strong><span class="text-muted">{{ member.workspaceRole === 'owner' ? 'Server owner' : 'Member' }}</span><template v-if="workspace.role === 'owner' && member.workspaceRole !== 'owner'"><UButton color="neutral" variant="outline" :disabled="busy" @click="choose(member, 'remove')">Remove</UButton><UButton color="error" variant="ghost" :disabled="busy" @click="choose(member, 'ban')">Ban</UButton></template></div>
    <template v-if="workspace.role === 'owner'"><h3>Banned members</h3><UAlert v-if="bans.isError.value" color="error" title="Could not load bans" /><p v-else-if="!bans.data.value?.length" class="text-muted">No bans.</p><div v-for="member in bans.data.value" :key="member.id" class="flex items-center justify-between gap-3"><span>{{ member.name }}</span><UButton color="neutral" variant="outline" :disabled="busy" @click="unban(member.id)">Remove ban</UButton></div></template>
    <UModal v-model:open="confirmOpen" :title="`${action === 'ban' ? 'Ban' : 'Remove'} ${selected?.name || 'member'}?`" :description="action === 'ban' ? 'They lose access and cannot rejoin until you remove their ban.' : 'They lose access, but can rejoin with a valid invitation.'"><template #body><UAlert v-if="error" color="error" :title="error" /><div class="flex justify-end gap-3"><UButton color="neutral" variant="outline" :disabled="busy" @click="confirmOpen = false">Cancel</UButton><UButton color="error" :loading="busy" @click="confirm">{{ action === 'ban' ? 'Ban member' : 'Remove member' }}</UButton></div></template></UModal>
  </div>
</template>

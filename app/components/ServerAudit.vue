<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import type { Member } from '../../shared/contracts'
const props = defineProps<{ workspaceId: string; members: Member[] }>()
const labels: Record<string, string> = { 'permissions.create': 'Created role', 'permissions.update': 'Updated role', 'permissions.delete': 'Deleted role', 'permissions.assign': 'Changed member roles', 'permissions.overrides': 'Changed channel permissions' }
function actorName(id: string) { return props.members.find(member => member.id === id)?.name || 'Former member' }
const api = apiFor()
const audit = useQuery({ queryKey: ['audit', props.workspaceId], queryFn: () => api('audit', { params: { workspaceId: props.workspaceId } }) })
</script>
<template>
  <div class="space-y-4"><h2>Audit log</h2><p class="section-description">The latest 100 role and permission changes.</p><UAlert v-if="audit.isError.value" color="error" :title="apiError(audit.error.value)" /><p v-if="audit.isPending.value" role="status">Loading audit log…</p><p v-else-if="!audit.data.value?.length">No changes recorded yet.</p><div v-for="event in audit.data.value" :key="event.id" class="rounded-lg bg-elevated p-4"><strong>{{ labels[event.action] || event.action }}</strong><p class="text-sm text-muted">{{ new Date(event.createdAt).toLocaleString() }} · {{ actorName(event.actorId) }}</p><p class="break-all text-sm">{{ event.targetId }}</p></div></div>
</template>

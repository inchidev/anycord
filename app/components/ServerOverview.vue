<script setup lang="ts">
import { can } from '../../shared/permissions'
const api = apiFor()
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { workspaceUpdateSchema, type Workspace } from '../../shared/contracts'
import { apiFor } from '../utils/api'
const props = defineProps<{ workspace: Workspace }>()
const queryClient = useQueryClient()
const state = reactive({ name: props.workspace.name, initials: props.workspace.initials })
const baseline = reactive({ ...state })
const dirty = computed(() => state.name !== baseline.name || state.initials !== baseline.initials)
const feedback = ref('')

const save = useMutation({
  mutationFn: (input: { id: string; name: string; initials: string }) => api('workspaceUpdate', { params: { workspaceId: input.id }, body: { name: input.name, initials: input.initials } }),
  onSuccess: async (workspace) => {
    if (workspace.id === props.workspace.id) { Object.assign(state, { name: workspace.name, initials: workspace.initials }); Object.assign(baseline, state); feedback.value = 'Server settings saved.' }
    await queryClient.invalidateQueries({ queryKey: ['bootstrap'] })
    await queryClient.invalidateQueries({ queryKey: ['server-picker'] })
  },
})
watch(() => [props.workspace.name, props.workspace.initials, save.isPending.value], () => {
  if (!dirty.value && !save.isPending.value && (baseline.name !== props.workspace.name || baseline.initials !== props.workspace.initials)) {
    Object.assign(state, { name: props.workspace.name, initials: props.workspace.initials }); Object.assign(baseline, state); feedback.value = ''; save.reset()
  }
})
function reset() { Object.assign(state, { name: props.workspace.name, initials: props.workspace.initials }); Object.assign(baseline, state); feedback.value = ''; save.reset() }
</script>
<template>
  <h2>Server Overview</h2>
  <p class="section-description">Make this server your own.</p>
  <UAlert v-if="!can(workspace, 'server.manage')" color="info" title="You need Manage server to change these settings." />
  <UForm :schema="workspaceUpdateSchema" :state="state" class="server-overview-form" @submit="feedback = ''; save.mutate({ id: workspace.id, ...state })">
    <div class="server-identity-edit"><div class="server-icon-preview" aria-label="Server icon preview">{{ state.initials || '?' }}</div><UFormField name="initials" label="SERVER ICON TEXT" description="Up to 4 characters shown in the server list."><UInput v-model="state.initials" aria-label="Server icon text" :maxlength="4" :disabled="!can(workspace, 'server.manage') || save.isPending.value" class="w-full" /></UFormField></div>
    <UFormField name="name" label="SERVER NAME"><UInput v-model="state.name" aria-label="Server name" :maxlength="50" :disabled="!can(workspace, 'server.manage') || save.isPending.value" class="w-full" /></UFormField>
    <UAlert v-if="save.isError.value" color="error" :title="apiError(save.error.value)" /><p v-if="feedback" class="settings-feedback" role="status">{{ feedback }}</p>
    <div v-if="can(workspace, 'server.manage')" class="settings-save-row"><span>{{ dirty ? 'You have unsaved changes.' : 'All changes saved.' }}</span><UButton variant="ghost" color="neutral" :disabled="!dirty || save.isPending.value" @click="reset">Reset</UButton><UButton type="submit" :disabled="!dirty" :loading="save.isPending.value">Save Changes</UButton></div>
  </UForm>
</template>

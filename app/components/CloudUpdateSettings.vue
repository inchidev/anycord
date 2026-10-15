<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { cloudUpdateInputSchema } from '../../shared/backup-settings'
import { apiFor } from '../utils/api'
defineProps<{ disabled?: boolean }>()
const api = apiFor(), client = useQueryClient()
const state = useQuery({ queryKey: ['cloud-updates'], queryFn: () => api('cloudUpdates'), staleTime: 300_000, refetchOnWindowFocus: false })
const form = reactive({ repository: '', workflow: 'installation-update.yml', token: '' }), busy = ref(false), error = ref(''), saved = ref(false)
watch(state.data, value => { if (value) Object.assign(form, { repository: value.repository, workflow: value.workflow }) }, { immediate: true })
async function save() { busy.value = true; error.value = ''; saved.value = false; try { await api('cloudUpdatesUpdate', { body: form }); form.token = ''; saved.value = true; await client.invalidateQueries({ queryKey: ['cloud-updates'] }) } catch (cause) { error.value = apiError(cause) } finally { busy.value = false } }
</script>
<template>
  <section class="space-y-4">
    <h3>Cloud update executor</h3>
    <p class="text-muted text-sm">GitHub Actions starts a temporary job when you request an update. Deployment credentials stay in that repository’s protected environment. No always-on runner or server is needed.</p>
    <p class="text-muted text-sm">Install the update workflow in your deployment repository and configure its installation.json and production secrets. The supplied workflow targets Cloudflare; a remote celld host needs its own deployment workflow.</p>
    <UButton to="https://github.com/inchidev/anycord/blob/main/.github/workflows/installation-update.yml" target="_blank" rel="noopener noreferrer" color="neutral" variant="outline">Update workflow template</UButton>
    <UForm :schema="cloudUpdateInputSchema" :state="form" :disabled="disabled" class="space-y-4" @submit="save">
      <UFormField name="repository" label="Deployment repository" required><UInput v-model="form.repository" placeholder="owner/repository" class="w-full" /></UFormField>
      <UFormField name="workflow" label="Update workflow" required><UInput v-model="form.workflow" class="w-full" /></UFormField>
      <UFormField name="token" label="GitHub Actions token" description="Use a fine-grained token scoped to this repository with Actions read/write. Leave blank to keep it for the same workflow."><UInput v-model="form.token" type="password" autocomplete="new-password" class="w-full" /></UFormField>
      <UButton type="submit" :loading="busy" :disabled="disabled || busy">Verify and save update executor</UButton>
    </UForm>
    <UAlert v-if="saved" color="success" title="Cloud update workflow verified and saved" />
    <UAlert v-if="error" color="error" :title="error" />
  </section>
</template>

<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { backupStorageInputSchema } from '../../shared/backup-settings'
import { apiFor } from '../utils/api'
defineProps<{ disabled?: boolean }>()
const api = apiFor(), client = useQueryClient()
const state = useQuery({ queryKey: ['backup-storage'], queryFn: () => api('backupStorage'), staleTime: 300_000, refetchOnWindowFocus: false })
const form = reactive({ endpoint: '', bucket: '', region: 'auto', accessKeyId: '', secretAccessKey: '' }), busy = ref(false), error = ref(''), saved = ref(false), recoveryKey = ref('')
watch(state.data, value => { if (value) Object.assign(form, { endpoint: value.endpoint, bucket: value.bucket, region: value.region }) }, { immediate: true })
async function save() {
  busy.value = true; error.value = ''; saved.value = false
  try { const result = await api('backupStorageUpdate', { body: form }); recoveryKey.value = result.recoveryKey || ''; form.accessKeyId = ''; form.secretAccessKey = ''; saved.value = true; await client.invalidateQueries({ queryKey: ['backup-storage'] }) }
  catch (cause) { error.value = apiError(cause) } finally { busy.value = false }
}
const recoveryPassword = ref('')
async function exportKey() { busy.value = true; error.value = ''; try { const result = await api('backupRecoveryKey', { body: { password: recoveryPassword.value } }); recoveryKey.value = result.key; recoveryPassword.value = '' } catch (cause) { error.value = apiError(cause) } finally { busy.value = false } }
async function copyKey() { try { await navigator.clipboard.writeText(recoveryKey.value) } catch { error.value = 'Select and copy the recovery key manually.' } }
</script>
<template>
  <section class="space-y-4">
    <h3>Backup storage</h3>
    <p class="text-muted text-sm">Backups go directly from this installation to a separate private S3-compatible bucket. Use a different bucket and credentials from attachments. No external runner is required.</p>
    <UAlert v-if="state.isError.value" color="error" title="Could not load backup storage" />
    <UForm :schema="backupStorageInputSchema" :state="form" :disabled="disabled" class="space-y-4" @submit="save">
      <UFormField name="endpoint" label="Backup S3 endpoint" required><UInput v-model="form.endpoint" placeholder="https://s3.example.com" class="w-full" /></UFormField>
      <div class="field-grid"><UFormField name="bucket" label="Backup bucket" required><UInput v-model="form.bucket" placeholder="anycord-backups" class="w-full" /></UFormField><UFormField name="region" label="Backup region" required><UInput v-model="form.region" class="w-full" /></UFormField></div>
      <UFormField name="accessKeyId" label="Backup access key" :description="state.data.value?.configured ? 'Leave credentials blank to keep them for the same bucket.' : 'Use credentials scoped to the separate backup bucket.'"><UInput v-model="form.accessKeyId" type="password" autocomplete="off" class="w-full" /></UFormField>
      <UFormField name="secretAccessKey" label="Backup secret key"><UInput v-model="form.secretAccessKey" type="password" autocomplete="new-password" class="w-full" /></UFormField>
      <UButton type="submit" :loading="busy" :disabled="disabled || busy">Verify and save backup storage</UButton>
    </UForm>
    <div v-if="state.data.value?.configured && !recoveryKey" class="space-y-3"><UFormField label="Current password for backup key"><UInput v-model="recoveryPassword" type="password" autocomplete="current-password" class="w-full" /></UFormField><UButton color="neutral" variant="outline" :disabled="disabled || busy || !recoveryPassword" @click="exportKey">Export recovery key</UButton></div>
    <UAlert v-if="saved" color="success" title="Separate backup storage verified and saved" />
    <div v-if="recoveryKey" class="space-y-3 rounded-lg bg-elevated p-4"><h4 class="font-semibold">Save your backup recovery key</h4><p class="text-muted text-sm">Backups are encrypted. Keep this key outside the installation and its S3 bucket; it is needed to recover after losing the installation.</p><UInput :model-value="recoveryKey" aria-label="Backup recovery key" readonly class="w-full" /><div class="flex flex-wrap gap-3"><UButton color="neutral" variant="outline" @click="copyKey">Copy recovery key</UButton><UButton color="neutral" variant="outline" @click="recoveryKey = ''">I saved the recovery key</UButton></div></div>
    <UAlert v-if="error" color="error" :title="error" />
  </section>
</template>

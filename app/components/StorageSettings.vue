<script setup lang="ts">
const api = apiFor()
import { useQuery, useMutation } from '@tanstack/vue-query'
import { apiFor } from '../utils/api'
const storage = useQuery({ queryKey: ['storage'], queryFn: () => api('storage') })
const form = reactive({ driver: 's3' as 'r2' | 's3', endpoint: '', bucket: '', region: 'auto', accessKeyId: '', secretAccessKey: '' })
const feedback = ref(''), error = ref('')
const values = () => ({ driver: form.driver, endpoint: form.endpoint, bucket: form.bucket, region: form.region })
const baseline = ref(JSON.stringify(values()))
const dirty = computed(() => JSON.stringify(values()) !== baseline.value || !!form.accessKeyId || !!form.secretAccessKey)
function reset(data = storage.data.value) { if (!data) return; Object.assign(form, { driver: data.driver || (data.nativeAvailable ? 'r2' : 's3'), endpoint: data.endpoint, bucket: data.bucket, region: data.region, accessKeyId: '', secretAccessKey: '' }); baseline.value = JSON.stringify(values()); error.value = ''; feedback.value = '' }
watch(storage.data, data => { if (data && !dirty.value) reset(data) }, { immediate: true })
const save = useMutation({ mutationFn: () => api('storageUpdate', { body: { ...form, accessKeyId: form.accessKeyId || undefined, secretAccessKey: form.secretAccessKey || undefined } }), onSuccess: async data => { reset(data); await storage.refetch(); feedback.value = 'Storage saved. Existing files keep their original storage destination.' }, onError: cause => { error.value = apiError(cause) } })
const test = useMutation({ mutationFn: () => api('storageTest'), onSuccess: () => { feedback.value = 'Upload and deletion verified.' }, onError: cause => { error.value = apiError(cause) } })
</script>
<template>
  <h2>File storage</h2><p class="section-description">Images and attachments live in a private bucket. Up to four files per message, 8 MB each.</p>
  <p v-if="storage.isPending.value">Loading storage settings…</p><UAlert v-else-if="storage.isError.value" color="error" :title="apiError(storage.error.value)" />
  <form v-else class="integration-form" @submit.prevent="error = ''; feedback = ''; save.mutate()">
    <UFormField label="STORAGE PROVIDER"><USelect :disabled="save.isPending.value" v-model="form.driver" :items="[...(storage.data.value?.nativeAvailable ? [{ label: 'Cloudflare R2 · deployment bucket', value: 'r2' }] : []), { label: 'S3 compatible · RustFS, R2, Amazon S3', value: 's3' }]" class="w-full" /></UFormField>
    <p v-if="form.driver === 'r2'">Uses the private R2 bucket attached to this Cloudflare deployment.</p>
    <template v-else>
      <UFormField label="S3 ENDPOINT" description="For Docker Compose with RustFS: http://rustfs:9000"><UInput :disabled="save.isPending.value" v-model="form.endpoint" type="url" required placeholder="https://ACCOUNT_ID.r2.cloudflarestorage.com" class="w-full" /></UFormField>
      <div class="field-grid"><UFormField label="BUCKET"><UInput :disabled="save.isPending.value" v-model="form.bucket" required placeholder="anycord-files" class="w-full" /></UFormField><UFormField label="REGION"><UInput :disabled="save.isPending.value" v-model="form.region" required placeholder="auto" class="w-full" /></UFormField></div>
      <UFormField label="ACCESS KEY ID"><UInput :disabled="save.isPending.value" v-model="form.accessKeyId" autocomplete="off" placeholder="Leave blank to keep the saved key" class="w-full" /></UFormField>
      <UFormField label="SECRET ACCESS KEY" description="Credentials are encrypted on the server and never returned to clients."><UInput :disabled="save.isPending.value" v-model="form.secretAccessKey" type="password" autocomplete="new-password" placeholder="Leave blank to keep the saved secret" class="w-full" /></UFormField>
    </template>
    <UAlert v-if="error" color="error" :title="error" /><UAlert v-if="feedback" color="success" :title="feedback" />
    <div class="integration-actions"><UButton type="submit" :disabled="!dirty && !!storage.data.value?.configured" :loading="save.isPending.value">Save Changes</UButton><UButton color="neutral" variant="outline" :disabled="!storage.data.value?.configured || dirty || save.isPending.value" :loading="test.isPending.value" @click="error = ''; feedback = ''; test.mutate()">Test connection</UButton><UButton color="neutral" variant="ghost" :disabled="!dirty || save.isPending.value" @click="reset()">Reset</UButton></div>
  </form>
</template>

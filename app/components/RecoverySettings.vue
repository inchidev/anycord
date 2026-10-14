<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { passwordProofSchema } from '../../shared/contracts'
import { apiFor } from '../utils/api'
const api = apiFor(), state = reactive({ password: '' }), keys = ref<string[]>([]), error = ref(''), busy = ref(false), copied = ref(false)
const status = useQuery({ queryKey: ['recovery'], queryFn: () => api('recoveryStatus') })
async function generate() {
  busy.value = true; error.value = ''; copied.value = false
  try { keys.value = (await api('recoveryGenerate', { body: state })).keys; state.password = ''; await status.refetch() }
  catch (cause) { error.value = apiError(cause) }
  finally { busy.value = false }
}
async function copy() {
  try { await navigator.clipboard.writeText(keys.value.join('\n')); copied.value = true }
  catch { error.value = 'Could not copy. Select the keys below and save them in your password manager.' }
}
onBeforeUnmount(() => { keys.value = []; state.password = '' })
</script>
<template>
  <div class="space-y-5"><h2>Recovery keys</h2><p class="section-description">Save these in your password manager. Anyone with a key and your username can reset your password on this installation. Keys cannot be shown again.</p>
    <UAlert v-if="status.isError.value" color="error" title="Could not load recovery status" />
    <p v-else-if="status.data.value">{{ status.data.value.count }} keys available.<span v-if="status.data.value.generatedAt"> Generated {{ new Date(status.data.value.generatedAt).toLocaleDateString() }}.</span></p>
    <template v-if="keys.length"><UAlert color="warning" title="Save your recovery keys now" description="This is the only time they are shown. Using one key revokes all old keys and sessions." /><pre class="select-text overflow-x-auto rounded-lg bg-elevated p-4 text-sm">{{ keys.join('\n') }}</pre><div class="flex flex-wrap gap-3"><UButton color="neutral" variant="outline" @click="copy">{{ copied ? 'Copied' : 'Copy keys' }}</UButton><UButton @click="keys = []">I saved my keys</UButton></div></template>
    <UForm v-else :schema="passwordProofSchema" :state="state" class="space-y-4" @submit="generate"><UFormField name="password" label="CURRENT PASSWORD" description="Generating a new set invalidates every previous recovery key." required><UInput v-model="state.password" type="password" autocomplete="current-password" class="w-full" /></UFormField><UButton type="submit" :loading="busy">Generate recovery keys</UButton></UForm>
    <UAlert v-if="error" color="error" :title="error" />
  </div>
</template>

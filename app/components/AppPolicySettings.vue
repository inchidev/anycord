<script setup lang="ts">
import { ZodError } from 'zod'
import { apiFor } from '../utils/api'
const api = apiFor(), enabled = ref(false), origins = ref(''), loading = ref(true), busy = ref(false), error = ref(''), feedback = ref('')
onMounted(async () => {
  try { const policy = await api('appPolicy'); enabled.value = policy.enabled; origins.value = policy.allowedOrigins.join('\n') }
  catch (cause) { error.value = cause instanceof ZodError ? cause.issues[0]?.message || 'Check the policy fields' : apiError(cause) }
  finally { loading.value = false }
})
async function save() {
  busy.value = true; error.value = ''; feedback.value = ''
  try {
    await api('appPolicyUpdate', { body: { enabled: enabled.value, allowedOrigins: origins.value.split('\n').map(v => v.trim()).filter(Boolean) } })
    feedback.value = 'App policy saved. Pending deliveries were cancelled.'
  } catch (cause) { error.value = cause instanceof ZodError ? cause.issues[0]?.message || 'Check the policy fields' : apiError(cause) }
  finally { busy.value = false }
}
</script>
<template>
  <section class="space-y-4 py-6">
    <h3>Server apps</h3>
    <p>Let server owners install bots and incoming webhooks with explicit channel access. Apps cannot log in as members or read message history.</p>
    <UAlert v-if="error" color="error" :title="error" />
    <form v-if="!loading" class="space-y-4" @submit.prevent="save">
      <UCheckbox v-model="enabled" label="Allow server owners to install and run apps" />
      <UFormField label="Approved event origins" description="One HTTPS origin per line, for example https://hooks.example.com. These endpoints can receive granted channel messages and command arguments.">
        <UTextarea v-model="origins" :rows="3" class="w-full" placeholder="https://hooks.example.com" />
      </UFormField>
      <p>Incoming webhooks and the built-in Ping app do not need an outbound origin. Disabling this policy blocks all app credentials and commands immediately.</p>
      <UAlert v-if="feedback" color="success" :title="feedback" />
      <UButton type="submit" :loading="busy">Save app policy</UButton>
    </form>
  </section>
</template>

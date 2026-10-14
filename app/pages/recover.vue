<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import { recoveryFormSchema } from '../../shared/contracts'
import { apiFor } from '../utils/api'
const api = apiFor({ origin: '', token: '' })
const client = useQueryClient()
const { $connections: connections } = useNuxtApp()
onMounted(() => { if (connections.active.value !== 'local') connections.select('local') })
const state = reactive({ name: '', recoveryKey: '', password: '', confirmPassword: '' })
const pending = ref(false), error = ref(''), complete = ref(false)
useHead({ title: 'Recover your account · Anycord' })
async function submit() {
  pending.value = true; error.value = ''
  try { await api('recoveryReset', { body: state }); client.clear(); state.recoveryKey = ''; state.password = ''; state.confirmPassword = ''; complete.value = true }
  catch (cause) { error.value = apiError(cause) }
  finally { pending.value = false }
}
</script>
<template>
  <main class="auth-screen"><NuxtLink to="/" class="auth-brand"><BrandMark wordmark /></NuxtLink><section class="auth-card">
    <h1>Recover your account</h1><p>Use a saved recovery key from this installation. Your messages and server memberships stay with your account.</p>
    <template v-if="complete"><UAlert color="success" title="Password reset" description="All old sessions and recovery keys have been revoked. Sign in with your new password and generate a new set of recovery keys." /><UButton to="/login" block>Back to log in</UButton></template>
    <UForm v-else :state="state" :schema="recoveryFormSchema" @submit="submit">
      <UFormField name="name" label="USERNAME" required><UInput v-model="state.name" autocomplete="username" class="w-full" /></UFormField>
      <UFormField name="recoveryKey" label="RECOVERY KEY" required><UInput v-model="state.recoveryKey" type="password" autocomplete="off" class="w-full" /></UFormField>
      <UFormField name="password" label="NEW PASSWORD" description="At least 10 characters." required><UInput v-model="state.password" type="password" autocomplete="new-password" class="w-full" /></UFormField>
      <UFormField name="confirmPassword" label="CONFIRM NEW PASSWORD" required><UInput v-model="state.confirmPassword" type="password" autocomplete="new-password" class="w-full" /></UFormField>
      <UAlert v-if="error" color="error" :title="error" /><UButton type="submit" :loading="pending" block>Reset password</UButton>
    </UForm><NuxtLink to="/login">Back to log in</NuxtLink>
  </section></main>
</template>

<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { authenticationInputSchema } from '../../shared/contracts'
const api = apiFor(), client = useQueryClient()
const policy = useQuery({ queryKey: ['authentication'], queryFn: () => api('authentication') })
const state = reactive({ passwordLogin: true, registration: true, telegramLogin: false, miniAppLogin: false })
const error = ref(''), feedback = ref('')
watch(policy.data, data => { if (data) Object.assign(state, data) }, { immediate: true })
const save = useMutation({ mutationFn: () => api('authenticationUpdate', { body: state }),
  onSuccess: async () => { feedback.value = 'Authentication settings saved for this installation.'; await Promise.all([client.invalidateQueries({ queryKey: ['authentication'] }), client.invalidateQueries({ queryKey: ['auth'] }), client.invalidateQueries({ queryKey: ['telegram-account'] })]) },
  onError: cause => { error.value = apiError(cause) },
})
</script>
<template>
  <h2>Authentication</h2>
  <p class="section-description">Choose how people sign in to this installation. These settings apply to every server hosted here.</p>
  <UAlert v-if="policy.isError.value" color="error" title="Could not load authentication settings" />
  <p v-if="policy.isPending.value">Loading authentication settings…</p>
  <UForm v-else-if="policy.data.value" :state="state" :schema="authenticationInputSchema" class="integration-form" @submit="error = ''; feedback = ''; save.mutate()">
    <UFormField name="passwordLogin" label="Username and password" description="Allow existing members to sign in with a password. Verify browser Telegram login with your owner account before turning this off."><USwitch v-model="state.passwordLogin" /></UFormField>
    <UFormField name="telegramLogin" label="Telegram browser login" description="Use the new Telegram OIDC flow. Configure credentials in Integrations → Telegram first."><USwitch v-model="state.telegramLogin" /></UFormField>
    <UFormField name="miniAppLogin" label="Telegram Mini App login" description="Automatically sign in when this installation is opened as a Telegram Mini App."><USwitch v-model="state.miniAppLogin" /></UFormField>
    <UFormField name="registration" label="Allow new accounts" description="Applies to password and Telegram registration. Existing members can still sign in and link Telegram when registration is closed."><USwitch v-model="state.registration" /></UFormField>
    <UAlert v-if="error" color="error" :title="error" /><UAlert v-if="feedback" color="success" :title="feedback" />
    <UButton type="submit" :loading="save.isPending.value">Save Authentication</UButton>
  </UForm>
</template>

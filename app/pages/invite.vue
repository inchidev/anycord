<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { apiFor } from '../utils/api'
import { serverPath } from '../../shared/navigation'
// Invitations always belong to the installation serving this page, regardless
// of which remote connection was active in this tab before opening the link.
const api = apiFor({ origin: '', token: '' }), { $connections: connections } = useNuxtApp(), client = useQueryClient()
const route = useRoute(), storageKey = 'anycord:pending-invitation'
const host = window.location.host
const token = ref(new URLSearchParams(route.hash.slice(1)).get('token') || sessionStorage.getItem(storageKey) || '')
if (route.hash) { sessionStorage.setItem(storageKey, token.value); void navigateTo('/invite', { replace: true }) }
const preview = useQuery({ queryKey: ['invite-preview', token.value], queryFn: () => api('invitePreview', { body: { token: token.value } }), retry: false, enabled: computed(() => !!token.value) })
const auth = useQuery({ queryKey: ['invite-auth'], queryFn: () => api('authStatus'), retry: false })
const busy = ref(false), error = ref('')
useHead({ title: 'Join a server · Anycord', meta: [{ name: 'referrer', content: 'no-referrer' }] })
async function join() {
  busy.value = true; error.value = ''
  try {
    const result = await api('inviteAccept', { body: { token: token.value } })
    sessionStorage.removeItem(storageKey); connections.select('local'); client.clear()
    await navigateTo(serverPath(result.workspaceId))
  } catch (cause) { error.value = apiError(cause) } finally { busy.value = false }
}
function login(register: boolean) { connections.select('local'); return navigateTo({ path: '/login', query: { next: '/invite', ...(register ? { mode: 'register' } : {}) } }) }
</script>
<template>
  <main class="auth-screen"><NuxtLink to="/" class="auth-brand"><BrandMark wordmark /></NuxtLink><section class="auth-card">
    <h1>You’re invited</h1><p>This invitation belongs to {{ host }}.</p>
    <UAlert v-if="!token" color="error" title="Invitation missing" description="Open the complete invitation link shared by the server owner." />
    <UAlert v-else-if="preview.isError.value" color="error" :title="apiError(preview.error.value)" />
    <p v-else-if="preview.isPending.value">Checking invitation…</p>
    <template v-else-if="preview.data.value"><h2>{{ preview.data.value.name }}</h2><p>Join this server to see its channels and chat with its members.</p><UAlert v-if="auth.isError.value" color="error" title="Could not check your sign-in" /><UButton v-else-if="auth.data.value?.user" :loading="busy" block @click="join">Join as {{ auth.data.value.user.name }}</UButton><div v-else-if="!auth.isPending.value" class="flex flex-col gap-3"><UButton block @click="login(false)">Log in to join</UButton><UButton color="neutral" variant="outline" block @click="login(true)">Create an account</UButton></div></template>
    <UAlert v-if="error" color="error" :title="error" />
  </section></main>
</template>

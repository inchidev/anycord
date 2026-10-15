<script setup lang="ts">
import { pendingInvitationKey } from '../../shared/invitations'
const { $connections: connections } = useNuxtApp()
const route = useRoute()
const token = new URLSearchParams(route.hash.slice(1)).get('token') || ''
if (route.hash) {
  try { sessionStorage.removeItem(pendingInvitationKey()); if (/^[a-f0-9]{48}$/.test(token)) sessionStorage.setItem(pendingInvitationKey(), token) } catch {}
  void navigateTo('/invite', { replace: true })
}
// Shared links belong to their serving origin. Wait for the connection remount
// before capturing its API and resolving Mini App authentication.
onMounted(() => { if (connections.active.value !== 'local') connections.select('local') })
useHead({ title: 'Join a server · Anycord', meta: [{ name: 'referrer', content: 'no-referrer' }] })
</script>
<template><main class="auth-screen"><NuxtLink to="/servers" class="auth-brand"><BrandMark wordmark /></NuxtLink><section class="auth-card"><InvitationJoin v-if="connections.active.value === 'local'" :initial-token="token" login-next="/invite" /><p v-else>Opening the invitation’s installation…</p></section></main></template>

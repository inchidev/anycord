<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { apiFor } from '../utils/api'
import { safeNext } from '../../shared/navigation'
const api = apiFor(), client = useQueryClient(), route = useRoute()
const { $connections: connections } = useNuxtApp()
const setup = route.hash.startsWith('#setup=')
onMounted(() => { if (setup && connections.active.value !== 'local') connections.select('local') })
const auth = useQuery({ queryKey: ['auth'], queryFn: () => api('authStatus'), retry: false, enabled: computed(() => !setup || connections.active.value === 'local') })
useHead({ title: computed(() => auth.data.value?.initialized === false ? 'Create your account · Anycord' : 'Log in · Anycord') })
watch(() => auth.data.value?.user, user => { if (user) void navigateTo(safeNext(route.query.next), { replace: true }) }, { immediate: true })
async function authenticated() { await client.invalidateQueries({ queryKey: ['auth'] }) }
</script>
<template>
  <main v-if="auth.isPending.value" class="boot-screen"><BrandMark wordmark /><p>Opening your account…</p></main>
  <main v-else-if="auth.isError.value" class="boot-screen"><BrandMark wordmark /><h1>Can’t reach this installation</h1><p>{{ connections.current.value?.origin || 'Try again in a moment.' }}</p><UButton @click="auth.refetch()">Try again</UButton><UButton color="neutral" variant="ghost" @click="connections.show()">Choose a different installation</UButton><NuxtLink to="/">Back to Anycord</NuxtLink></main>
  <AuthGate v-else-if="!auth.data.value?.user" :initialized="auth.data.value?.initialized || false" :setup-required="auth.data.value?.setupRequired" :methods="auth.data.value?.methods" @authenticated="authenticated" />
  <main v-else class="boot-screen"><BrandMark /><p>Opening your servers…</p></main>
</template>

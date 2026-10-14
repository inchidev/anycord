<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { apiFor } from '../utils/api'
import { serverPath } from '../../shared/navigation'
const api = apiFor(), { $connections: connections } = useNuxtApp()
const auth = useQuery({ queryKey: ['auth'], queryFn: () => api('authStatus'), retry: false })
watch(() => auth.data.value, value => { if (value && !value.user) void navigateTo('/login?next=/servers', { replace: true }) }, { immediate: true })
const bootstrap = useInstallationServers(() => auth.data.value?.user?.id)
useHead({ title: 'Your servers · Anycord' })
const host = computed(() => connections.current.value?.origin || window.location.origin)
</script>
<template>
  <main class="server-picker-screen">
    <header class="product-nav"><NuxtLink to="/" aria-label="Anycord home"><BrandMark wordmark /></NuxtLink><UButton color="neutral" variant="ghost" icon="i-lucide-globe" @click="connections.show()">Your connections</UButton></header>
    <section class="server-picker-content">
      <p class="picker-eyebrow">{{ auth.data.value?.user ? `SIGNED IN AS ${auth.data.value.user.name}` : 'ANYCORD' }}</p><h1>Your people are here.</h1><p class="picker-description">Choose a server on this installation.</p>
      <button class="installation-switch" @click="connections.show()"><UIcon name="i-lucide-plug" /><span>{{ connections.label.value }}<small class="block text-xs text-muted">{{ host }}</small></span><UIcon name="i-lucide-chevron-down" /></button>
      <div v-if="auth.isError.value || bootstrap.isError.value" class="picker-error"><UAlert color="error" :title="apiError(auth.error.value || bootstrap.error.value)" /><UButton @click="auth.refetch(); bootstrap.refetch()">Try again</UButton></div>
      <div v-else-if="bootstrap.isPending.value" class="server-picker-grid"><USkeleton v-for="i in 3" :key="i" class="h-32 rounded-xl" /></div>
      <div v-else class="server-picker-grid"><NuxtLink v-for="server in bootstrap.data.value" :key="server.id" :to="serverPath(server.id)" class="server-choice"><span class="server-choice-icon">{{ server.initials }}</span><strong>{{ server.name }}</strong><span>Open server <UIcon name="i-lucide-arrow-up-right" /></span></NuxtLink><button v-if="auth.data.value?.user?.role === 'owner'" class="server-choice create-choice" @click="connections.show('create')"><UIcon name="i-lucide-plus" /><strong>Create a server</strong><span>A place for your people</span></button></div>
      <p class="picker-footnote">These servers share your account on {{ host }}. To open a different installation, add its address in Your connections and sign in there.</p>
    </section>

  </main>
</template>

<script setup lang="ts">
import { serverPath } from '../../shared/navigation'
const { $connections: connections, $pwa: pwa } = useNuxtApp()
const auth = useAuthSession()
watch(() => auth.data.value, value => { if (value && !value.user) void navigateTo('/login?next=/servers', { replace: true }) }, { immediate: true })
const bootstrap = useInstallationServers(() => auth.data.value?.user?.id)
useHead({ title: 'Your servers · Anycord' })
const host = computed(() => connections.current.value?.origin || window.location.origin)
const hostname = computed(() => new URL(host.value).host)
const installationName = computed(() => connections.label.value === hostname.value ? 'This installation' : connections.label.value)
const showSkeletons = ref(false)
let loadingTimer: ReturnType<typeof setTimeout> | undefined
watch(() => bootstrap.isPending.value, pending => {
  clearTimeout(loadingTimer); showSkeletons.value = false
  if (pending) loadingTimer = setTimeout(() => { showSkeletons.value = true }, 300)
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(loadingTimer))
</script>
<template>
  <main v-if="auth.isPending.value || (!auth.isError.value && !auth.data.value?.user)" class="boot-screen" role="status"><BrandMark wordmark /><p>Opening your servers…</p></main>
  <main v-else class="server-picker-screen">
    <header class="picker-nav"><NuxtLink to="/" aria-label="Anycord home"><BrandMark wordmark /></NuxtLink></header>
    <section class="server-picker-content" aria-labelledby="servers-heading">
      <button class="installation-switch" aria-label="Switch installation" @click="connections.show()"><span class="installation-symbol"><UIcon name="i-lucide-globe" /></span><span class="installation-address"><strong>{{ installationName }}</strong><small>{{ hostname }}</small></span><span class="installation-action">Switch<UIcon name="i-lucide-chevrons-up-down" /></span></button>
      <div class="picker-heading"><div><h1 id="servers-heading">Servers</h1><p class="picker-description">Choose where to pick up the conversation.</p></div></div>
      <div v-if="auth.isError.value || bootstrap.isError.value" class="picker-error"><UAlert color="error" :title="apiError(auth.error.value || bootstrap.error.value)" /><UButton @click="auth.refetch(); bootstrap.refetch()">Try again</UButton></div>
      <div v-else-if="bootstrap.isPending.value" class="server-picker-list picker-loading" role="status" aria-label="Loading servers"><template v-if="showSkeletons"><div v-for="i in 3" :key="i" class="server-choice"><USkeleton class="size-12 shrink-0 rounded-2xl bg-accented" /><div class="server-choice-copy"><USkeleton class="h-4 w-36 max-w-full bg-accented" /><USkeleton class="mt-2 h-3 w-20 bg-accented" /></div></div></template></div>
      <template v-else>
        <ul v-if="bootstrap.data.value?.length" class="server-picker-list" aria-label="Your servers"><li v-for="server in bootstrap.data.value" :key="server.id"><NuxtLink :to="serverPath(server.id)" class="server-choice"><span class="server-choice-icon" aria-hidden="true">{{ server.initials }}</span><span class="server-choice-copy"><strong>{{ server.name }}</strong><small>Open server</small></span><UIcon name="i-lucide-chevron-right" class="server-choice-arrow" /></NuxtLink></li></ul>
        <div v-else class="picker-empty"><UIcon name="i-lucide-messages-square" /><h2>No servers yet</h2><p>{{ auth.data.value?.user?.role === 'owner' ? 'Create your first server to start a conversation.' : 'Ask a server owner for an invitation, or switch installation.' }}</p></div>
        <button v-if="auth.data.value?.user?.role === 'owner'" class="picker-create" @click="connections.show('create')"><span><UIcon name="i-lucide-plus" /></span>Create a server</button>
      </template>
      <footer class="picker-footer"><span v-if="auth.data.value?.user" class="picker-account"><UIcon name="i-lucide-user-round" /><span>Signed in as <strong>{{ auth.data.value.user.name }}</strong></span></span><UButton v-if="pwa.canInstall.value" variant="ghost" color="neutral" icon="i-lucide-download" @click="pwa.install()">Install Anycord</UButton></footer>
    </section>
  </main>
</template>

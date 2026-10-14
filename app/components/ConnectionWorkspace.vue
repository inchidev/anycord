<script setup lang="ts">
import { QueryClient, VUE_QUERY_CLIENT } from '@tanstack/vue-query'
const client = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: true } } })
client.mount()
provide(VUE_QUERY_CLIENT, client)
onBeforeUnmount(() => { void client.cancelQueries(); client.clear(); client.unmount() })
</script>
<template><NuxtPage /><ConnectionDialog /></template>

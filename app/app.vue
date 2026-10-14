<script setup lang="ts">
const { $connections: connections } = useNuxtApp()
</script>
<template><UApp><ConnectionWorkspace :key="`${connections.active.value}:${connections.revision.value}`" /></UApp></template>

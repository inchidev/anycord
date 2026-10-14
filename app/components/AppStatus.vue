<script setup lang="ts">
const { $pwa: pwa } = useNuxtApp()
</script>
<template>
  <div v-if="!pwa.online.value || pwa.waiting.value || pwa.error.value" class="app-status" role="status" aria-live="polite">
    <span v-if="!pwa.online.value">You’re offline. Your drafts stay here. Reconnect to load conversations and send messages.</span>
    <span v-else-if="pwa.waiting.value">An Anycord update is ready. Your saved drafts will be kept.</span>
    <span v-else>{{ pwa.error.value }}</span>
    <template v-if="pwa.online.value && pwa.waiting.value"><UButton size="sm" :loading="pwa.updating.value" @click="pwa.update()">Update now</UButton><small v-if="pwa.error.value">{{ pwa.error.value }}</small></template>
  </div>
  <UModal v-model:open="pwa.help.value" title="Install Anycord" description="Keep your communities a tap away.">
    <template #body>
      <p>On iPhone or iPad, open Anycord in Safari, tap Share, then Add to Home Screen.</p>
      <p class="mt-3">On Android or desktop, open your browser menu and choose Install app or Add to Home Screen. If it is unavailable, keep using Anycord in your browser.</p>
      <p class="mt-3 text-muted">An internet connection is needed for conversations. Notification permission is optional and is not needed to install.</p>
    </template>
  </UModal>
</template>

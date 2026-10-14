<script setup lang="ts">
const open = defineModel<boolean>('open', { default: false })
defineProps<{ title: string; label: string }>()
</script>
<template>
  <UModal v-model:open="open" fullscreen :title="title" :close="false" :ui="{ header: 'sr-only', body: 'p-0 sm:p-0 min-h-0 flex-1 overflow-hidden', content: 'settings-fullscreen' }">
    <template #body>
      <div class="settings-screen">
        <div class="settings-navigation"><nav class="settings-nav" :aria-label="`${title} sections`"><span>{{ label }}</span><slot name="navigation" /></nav></div>
        <div class="settings-content"><section class="settings-main"><slot /></section></div>
        <button class="settings-close" aria-label="Close settings" @click="open = false"><span><UIcon name="i-lucide-x" /></span><small>ESC</small></button>
      </div>
    </template>
  </UModal>
</template>

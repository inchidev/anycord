<script setup lang="ts">
const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{ title: string; label: string; description?: string }>()
const heading = useTemplateRef<HTMLElement>('heading'), content = useTemplateRef<HTMLElement>('content')
const navigation = useTemplateRef<HTMLElement>('navigation')
watch(() => props.title, async () => {
  if (!open.value) return
  await nextTick()
  if (content.value) content.value.scrollTop = 0
  if (navigation.value) navigation.value.scrollLeft = 0
  heading.value?.focus({ preventScroll: true })
})
</script>
<template>
  <UModal v-model:open="open" fullscreen :title="title" :description="description" :close="false" :ui="{ header: 'sr-only', body: 'p-0 sm:p-0 min-h-0 flex-1 overflow-hidden', content: 'settings-fullscreen' }">
    <template #body>
      <div class="settings-screen">
        <div ref="navigation" class="settings-navigation"><nav class="settings-nav" :aria-label="`${title} sections`"><span>{{ label }}</span><slot name="navigation" /></nav></div>
        <div ref="content" class="settings-content"><section class="settings-main"><header class="settings-context"><h1 ref="heading" tabindex="-1">{{ title }}</h1><p v-if="description">{{ description }}</p></header><slot /></section></div>
        <button class="settings-close" aria-label="Close settings" @click="open = false"><span><UIcon name="i-lucide-x" /></span><small>ESC</small></button>
      </div>
    </template>
  </UModal>
</template>

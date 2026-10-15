<script setup lang="ts">
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useResizeObserver } from '@vueuse/core'
import type { ComponentPublicInstance } from 'vue'
import type { Message } from '../../shared/contracts'

const props = defineProps<{ messages: Message[]; focusId?: string; ready: boolean; label: string; thread?: boolean }>()
const emit = defineEmits<{ latest: [] }>()
const viewport = useTemplateRef<HTMLElement>('viewport')
const atLatest = ref(true)
let positioned = false, focused = ''
// The introductory/status slot is a measured row too, so changes to loading
// states and attachments share the same coordinate system as message rows.
const virtualizer = useVirtualizer(computed(() => ({
  count: props.messages.length + 1,
  getScrollElement: () => viewport.value,
  getItemKey: (index: number) => index === 0 ? 'intro' : props.messages[index - 1]!.id,
  estimateSize: (index: number) => index === 0 ? 200 : 100,
  overscan: 5,
  paddingStart: props.thread ? 16 : 24,
  paddingEnd: 16,
  anchorTo: 'end' as const,
  followOnAppend: !props.focusId,
  scrollEndThreshold: 80,
})))
const items = computed(() => virtualizer.value.getVirtualItems())
function measure(element: Element | ComponentPublicInstance | null) {
  if (element instanceof HTMLElement) virtualizer.value.measureElement(element)
}
function updatePosition() {
  const el = viewport.value
  if (el) atLatest.value = el.scrollHeight - el.clientHeight - el.scrollTop < 80
}
function scrollToLatest() {
  virtualizer.value.scrollToEnd()
  atLatest.value = true
}
function latest() {
  if (props.focusId) emit('latest')
  else scrollToLatest()
}
async function keepLatestVisible() {
  if (!positioned || !atLatest.value || props.focusId || !props.ready) return
  // Wait for Vue to commit the measured total height before scrolling. A
  // synchronous ResizeObserver adjustment can be clamped to the old DOM height.
  await nextTick()
  if (viewport.value && props.ready && atLatest.value && !props.focusId) scrollToLatest()
}
watch(() => virtualizer.value.getTotalSize(), keepLatestVisible)
useResizeObserver(viewport, keepLatestVisible)
watch([() => props.ready, () => props.messages, viewport], async () => {
  await nextTick()
  if (!props.ready || !viewport.value) return
  if (props.focusId) {
    const index = props.messages.findIndex(message => message.id === props.focusId)
    if (index >= 0 && focused !== props.focusId) {
      virtualizer.value.scrollToIndex(index + 1, { align: 'center' })
      focused = props.focusId
    }
  } else if (!positioned) {
    scrollToLatest()
    positioned = true
  }
}, { flush: 'post', immediate: true })
defineExpose({ scrollToLatest })
</script>

<template>
  <div class="timeline-shell">
    <div ref="viewport" :class="[thread ? 'thread-timeline' : 'message-timeline', 'virtual-timeline']" role="log" :aria-label="label" aria-live="polite" aria-relevant="additions" @scroll.passive="updatePosition">
      <div class="virtual-timeline-space" :style="{ height: `${virtualizer.getTotalSize()}px` }">
        <div class="virtual-timeline-block" :style="{ transform: `translateY(${items[0]?.start || 0}px)` }">
          <div v-for="item in items" :key="String(item.key)" :ref="measure" :data-index="item.index" class="virtual-message-row" :class="{ 'focused-message': item.index > 0 && messages[item.index - 1]?.id === focusId }">
            <slot v-if="item.index === 0" name="intro" />
            <slot v-else :message="messages[item.index - 1]!" :index="item.index - 1" />
          </div>
        </div>
      </div>
    </div>
    <button v-if="focusId || (ready && !atLatest)" class="go-to-latest" aria-label="Go to latest messages" @click="latest"><span>{{ focusId ? 'Viewing older messages' : 'You’re viewing earlier messages' }}</span><strong>Go to latest messages <UIcon name="i-lucide-arrow-down" /></strong></button>
  </div>
</template>

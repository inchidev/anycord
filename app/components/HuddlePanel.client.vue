<script setup lang="ts">
import type RealtimeKitClient from '@cloudflare/realtimekit'
const props = defineProps<{ token: string; channel: string }>()
const emit = defineEmits<{ leave: [] }>()
const element = useTemplateRef<HTMLElement & { meeting?: RealtimeKitClient; showSetupScreen?: boolean }>('meetingElement')
const error = ref('')
const ready = ref(false)
let meeting: RealtimeKitClient | undefined
let disposed = false
onMounted(async () => {
  try {
    const [{ default: Client }, { defineCustomElements }] = await Promise.all([import('@cloudflare/realtimekit'), import('@cloudflare/realtimekit-ui/loader')])
    if (disposed) return
    defineCustomElements(window, { resourcesUrl: '/rtk/' })
    const initialized = await Client.init({ authToken: props.token, defaults: { audio: true, video: false } })
    if (disposed) { await initialized.leave(); return }
    meeting = initialized
    meeting.self.on('roomLeft', () => emit('leave'))
    if (element.value) { element.value.meeting = meeting; element.value.showSetupScreen = true }
    ready.value = true
  } catch { error.value = 'Could not initialize the huddle. Check microphone permissions and the RealtimeKit participant preset.' }
})
onBeforeUnmount(() => { disposed = true; void meeting?.leave().catch(() => undefined) })
</script>

<template>
  <div class="huddle-panel">
    <header><span><UIcon name="i-lucide-audio-lines" /> {{ channel }}</span><UButton color="error" icon="i-lucide-phone-off" @click="emit('leave')">Disconnect</UButton></header>
    <UAlert v-if="error" color="error" :title="error" />
    <p v-else-if="!ready" role="status">Connecting to your huddle…</p>
    <rtk-meeting ref="meetingElement" show-setup-screen="true" class="rtk-surface" />
  </div>
</template>

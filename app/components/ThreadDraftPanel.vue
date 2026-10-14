<script setup lang="ts">
const api = apiFor()
import { useResizeObserver } from '@vueuse/core'
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import type { Message } from '../../shared/contracts'
import { getApiTarget } from '../utils/connection'
import { prepareAttempt } from '../../shared/drafts'
import { apiFor } from '../utils/api'
const props = defineProps<{ target: Message; userId: string; modal: boolean }>()
const emit = defineEmits<{ close: []; created: [id: string]; layout: [metrics: { bottom: number; height: number }] }>()
const draftScope = getApiTarget().origin
const { $draftStore } = useNuxtApp(), queryClient = useQueryClient()
const ownerId = props.userId, target = props.target, key = `new-thread:${target.channelId}:${target.id}`
const store = $draftStore(ownerId, draftScope)
function ensureDraft() {
  if (!store[key]?.threadDraft) store[key] = { text: '', threadDraft: { id: crypto.randomUUID(), name: '' } }
  return store[key]!
}
ensureDraft()
const name = computed({ get: () => store[key]?.threadDraft?.name || '', set: (value: string) => { ensureDraft().threadDraft!.name = value } })
const text = computed({ get: () => store[key]?.text || '', set: (value: string) => { ensureDraft().text = value } })
const pending = useState<Record<string, boolean>>('anycord-pending-sends', () => ({}))
const pendingKey = `${draftScope}:${ownerId}:${key}`, busy = computed(() => !!pending.value[pendingKey])
const panel = useTemplateRef<HTMLElement>('panel'), draftComposer = useTemplateRef<HTMLElement>('draftComposer')
useResizeObserver(draftComposer, () => { const box = draftComposer.value?.querySelector('.composer-box')?.getBoundingClientRect(); if (box) emit('layout', { bottom: window.innerHeight - box.bottom, height: box.height }) })
let disposed = false
onBeforeUnmount(() => { disposed = true })
onMounted(() => requestAnimationFrame(() => (panel.value?.querySelector<HTMLElement>('input:not([disabled])') || panel.value?.querySelector<HTMLButtonElement>('button'))?.focus()))
const send = useMutation({
  mutationFn: async (input: { name: string; text: string; id: string }) => {
    let threadId = store[key]?.threadDraft?.createdId
    if (!threadId) {
      const thread = await api('threadCreate', { params: { channelId: target.channelId }, body: { id: input.id, name: input.name, parentMessageId: target.id } })
      threadId = thread.id
      ensureDraft().threadDraft!.createdId = threadId
    }
    const attempt = prepareAttempt(store[key]?.attempt, { text: input.text, channelId: target.channelId, threadId })
    ensureDraft().attempt = attempt
    await api('messageCreate', { params: { channelId: target.channelId }, body: { id: attempt.id, text: attempt.text, threadId } })
    return { threadId, attempt }
  },
  onSuccess: async ({ threadId, attempt }) => {
    if (store[key]?.attempt?.id === attempt.id && store[key]?.text.trim() === attempt.text) ensureDraft().threadDraft!.completedId = threadId
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['messages', target.channelId] }), queryClient.invalidateQueries({ queryKey: ['threads', target.channelId] }), queryClient.invalidateQueries({ queryKey: ['thread', target.channelId] })])
  },
  onSettled: () => { delete pending.value[pendingKey] },
})
watch(() => store[key]?.threadDraft?.completedId, (id) => {
  if (id && !disposed) { delete store[key]; emit('created', id) }
}, { immediate: true, flush: 'post' })
function submit() {
  if (busy.value || !name.value.trim() || !text.value.trim()) return
  pending.value[pendingKey] = true
  send.mutate({ name: name.value.trim(), text: text.value.trim(), id: ensureDraft().threadDraft!.id })
}
function keydown(event: KeyboardEvent) {
  if (event.defaultPrevented) return
  if (event.key === 'Escape') { event.stopPropagation(); emit('close') }
  if (props.modal && event.key === 'Tab') {
    const controls = panel.value?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled])')
    const first = controls?.[0], last = controls?.[controls.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
}
function messageKeydown(event: KeyboardEvent) { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit() } }
</script>
<template>
  <aside ref="panel" class="thread-panel" :class="{ 'thread-overlay': modal }" :role="modal ? 'dialog' : 'complementary'" :aria-modal="modal || undefined" aria-label="New thread" @keydown="keydown">
    <header class="thread-header"><UIcon name="i-lucide-messages-square" /><h2>New thread</h2><UButton icon="i-lucide-x" color="neutral" variant="ghost" aria-label="Close thread" @click="emit('close')" /></header>
    <form class="thread-draft-form" @submit.prevent="submit">
      <div class="thread-draft-content"><UFormField label="THREAD NAME"><UInput v-model="name" aria-label="Thread name" placeholder="Name your thread" :maxlength="100" required :disabled="busy || !!store[key]?.threadDraft?.createdId" class="w-full" /></UFormField><div class="thread-origin"><p>Starting from {{ target.author }}</p><MessageText :text="target.text" /></div><p class="thread-draft-hint">A new conversation starts here.<br />Send the first message to create your thread.</p></div>
      <div ref="draftComposer" class="message-composer"><div class="composer-box"><UTextarea v-model="text" aria-label="First thread message" placeholder="Send a message to start the thread" :maxlength="4000" :rows="1" :maxrows="6" autoresize variant="none" class="composer-input" :disabled="busy" @keydown="messageKeydown" /><UButton type="submit" icon="i-lucide-send-horizontal" aria-label="Create thread and send message" :loading="busy" :disabled="!name.trim() || !text.trim()" /></div><div class="composer-status" role="status"><span v-if="send.isError.value" class="send-error">{{ apiError(send.error.value) }} <button type="button" @click="submit">Retry</button></span><span v-else>Shift + Enter for a new line</span></div></div>
    </form>
  </aside>
</template>

<script setup lang="ts">
import type { Message, User } from '../../shared/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
const props = defineProps<{ workspaceId: string; channelId: string; threadId: string; user: User; owner: boolean; modal: boolean; focusId?: string; typing?: string }>()
const emit = defineEmits<{ close: []; jump: [messageId: string]; copyLink: [message: Message]; typing: [event: { type: 'typing'; channelId: string; threadId?: string }]; layout: [metrics: { bottom: number; height: number }] }>()
const { query: thread, messages } = useThreadMessages(() => ({ userId: props.user.id, workspaceId: props.workspaceId, channelId: props.channelId, threadId: props.threadId, focus: props.focusId }))
const replyTo = ref<Message | null>(null)
const composer = useTemplateRef('composer')
const panel = useTemplateRef<HTMLElement>('panel'), timeline = useTemplateRef<HTMLElement>('timeline')
const messageAction = useMessageActions()
const api = apiFor(), client = useQueryClient(), followError = ref('')
const followKey = computed(() => ['thread-follow', props.channelId, props.threadId])
const follow = useQuery({ queryKey: followKey, queryFn: () => api('threadFollow', { params: { channelId: props.channelId, threadId: props.threadId } }) })
const setFollow = useMutation({ mutationFn: () => api('threadFollowUpdate', { params: { channelId: props.channelId, threadId: props.threadId }, body: { following: !follow.data.value?.following } }), onSuccess: () => client.invalidateQueries({ queryKey: followKey.value }), onError: cause => { followError.value = apiError(cause) } })
let restoreFocus: HTMLElement | null = null, lastFocus = ''
onMounted(() => { restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; if (props.modal) panel.value?.focus() })
onBeforeUnmount(() => { if (restoreFocus?.isConnected) restoreFocus.focus() })
watch(() => props.threadId, async () => { replyTo.value = null; lastFocus = ''; await nextTick(); if (props.modal) panel.value?.focus() })
watch(() => props.modal, async (modal) => { await nextTick(); if (modal) panel.value?.focus() })
watch(messages, async (_rows, old) => {
  const nearBottom = !old?.length || !timeline.value || timeline.value.scrollHeight - timeline.value.scrollTop - timeline.value.clientHeight < 160
  await nextTick()
  if (props.focusId && props.focusId !== lastFocus) { panel.value?.querySelector(`[id="message-${CSS.escape(props.focusId)}"]`)?.scrollIntoView({ block: 'center' }); lastFocus = props.focusId }
  else if (!props.focusId && nearBottom) timeline.value?.scrollTo({ top: timeline.value.scrollHeight })
})
function reply(message: Message) { replyTo.value = message; void nextTick(() => composer.value?.focus()) }
function keydown(event: KeyboardEvent) {
  if (event.defaultPrevented) return
  if (event.key === 'Escape') { event.stopPropagation(); emit('close') }
  if (props.modal && event.key === 'Tab') {
    const controls = panel.value?.querySelectorAll<HTMLElement>('button:not([disabled]), textarea, input, [tabindex="0"]')
    const first = controls?.[0], last = controls?.[controls.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
}
</script>

<template>
  <aside ref="panel" class="thread-panel" :class="{ 'thread-overlay': modal }" :role="modal ? 'dialog' : 'complementary'" :aria-modal="modal || undefined" aria-label="Thread" tabindex="-1" @keydown="keydown">
    <header class="thread-header"><UIcon name="i-lucide-messages-square" /><h2>{{ thread.data.value?.thread.name || 'Thread' }}</h2><UButton :icon="follow.data.value?.following ? 'i-lucide-bell-ring' : 'i-lucide-bell'" color="neutral" variant="ghost" :aria-label="follow.data.value?.following ? 'Unfollow thread' : 'Follow thread'" :title="follow.data.value?.following ? 'Unfollow thread' : 'Follow thread for notifications'" :disabled="!follow.data.value" :loading="setFollow.isPending.value" @click="followError = ''; setFollow.mutate()" /><UButton icon="i-lucide-x" color="neutral" variant="ghost" aria-label="Close thread" @click="emit('close')" /></header>
    <UAlert v-if="followError" color="error" :title="followError" />
    <div ref="timeline" class="thread-timeline" role="log" aria-label="Thread messages" aria-live="polite">
      <p v-if="thread.isPending.value" class="thread-notice">Loading thread…</p>
      <div v-else-if="thread.isError.value" class="content-error"><p>{{ apiError(thread.error.value) }}</p><UButton @click="thread.refetch()">Try again</UButton></div>
      <template v-else-if="thread.data.value">
        <div class="thread-origin"><p>Thread started from</p><MessageText v-if="thread.data.value.parent" :text="thread.data.value.parent.text" /><p v-else>Original message was deleted.</p></div>
        <p v-if="!messages.length" class="thread-notice">No messages yet. Start the conversation.</p>
        <MessageItem v-for="message in messages" :key="message.id" :message="message" :mine="message.authorId === user.id" :can-delete="message.authorId === user.id || owner" :allow-thread="false" @edit="(text, done) => messageAction(message, 'PATCH', { text }).then(done)" @delete="done => messageAction(message, 'DELETE').then(done)" @react="messageAction(message, 'POST', { emoji: $event })" @reply="reply(message)" @quote="composer?.quote(message)" @jump="emit('jump', $event)" @copy-link="emit('copyLink', message)" />
      </template>
    </div>
    <ChatComposer v-if="thread.data.value" ref="composer" :user-id="user.id" :workspace-id="workspaceId" :channel-id="channelId" :thread-id="threadId" :channel-name="thread.data.value.thread.name" :reply-to="replyTo" :typing="typing" @clear-reply="replyTo = null" @typing="emit('typing', $event)" @sent="emit('jump', '')" @layout="emit('layout', $event)" />
  </aside>
</template>

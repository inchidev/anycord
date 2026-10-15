<script setup lang="ts">
import type { Message, User } from '../../shared/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
const props = defineProps<{ workspaceId: string; channelId: string; threadId: string; user: User; owner: boolean; permissions: string[]; modal: boolean; focusId?: string; typing?: string }>()
const emit = defineEmits<{ close: []; jump: [messageId: string]; copyLink: [message: Message]; typing: [event: { type: 'typing'; channelId: string; threadId?: string }]; layout: [metrics: { bottom: number; height: number }] }>()
const { query: thread, messages } = useThreadMessages(() => ({ userId: props.user.id, workspaceId: props.workspaceId, channelId: props.channelId, threadId: props.threadId, focus: props.focusId }))
const replyTo = ref<Message | null>(null)
const composer = useTemplateRef('composer')
const panel = useTemplateRef<HTMLElement>('panel'), timeline = useTemplateRef('timeline')
const messageAction = useMessageActions()
const api = apiFor(), client = useQueryClient(), followError = ref('')
const followKey = computed(() => ['thread-follow', props.channelId, props.threadId])
const follow = useQuery({ queryKey: followKey, queryFn: () => api('threadFollow', { params: { channelId: props.channelId, threadId: props.threadId } }) })
const setFollow = useMutation({ mutationFn: () => api('threadFollowUpdate', { params: { channelId: props.channelId, threadId: props.threadId }, body: { following: !follow.data.value?.following } }), onSuccess: () => client.invalidateQueries({ queryKey: followKey.value }), onError: cause => { followError.value = apiError(cause) } })
let restoreFocus: HTMLElement | null = null
onMounted(() => { restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; if (props.modal) panel.value?.focus() })
onBeforeUnmount(() => { if (restoreFocus?.isConnected) restoreFocus.focus() })
watch(() => props.threadId, async () => { replyTo.value = null; await nextTick(); if (props.modal) panel.value?.focus() })
watch(() => props.modal, async (modal) => { await nextTick(); if (modal) panel.value?.focus() })
function latestMessages() {
  if (props.focusId) emit('jump', '')
  else timeline.value?.scrollToLatest()
}
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
    <MessageTimeline :key="`${user.id}:${workspaceId}:${channelId}:${threadId}:${focusId || 'latest'}`" ref="timeline" :messages="messages" :focus-id="focusId" :ready="!thread.isPending.value && !thread.isError.value" label="Thread messages" thread @latest="latestMessages">
      <template #intro>
        <p v-if="thread.isPending.value" class="thread-notice">Loading thread…</p>
        <div v-else-if="thread.isError.value" class="content-error"><p>{{ apiError(thread.error.value) }}</p><UButton @click="thread.refetch()">Try again</UButton></div>
        <template v-else-if="thread.data.value">
          <div class="thread-origin"><p>Thread started from</p><MessageText v-if="thread.data.value.parent" :text="thread.data.value.parent.text" /><p v-else>Original message was deleted.</p></div>
          <p v-if="!messages.length" class="thread-notice">No messages yet. Start the conversation.</p>
        </template>
      </template>
      <template #default="{ message }">
        <MessageItem :message="message" :mine="message.authorId === user.id" :can-delete="message.authorId === user.id || owner" :can-edit="permissions.includes('messages.send')" :can-react="permissions.includes('reactions.add')" :replyable="permissions.includes('messages.send')" :allow-thread="false" @edit="(text, done) => messageAction(message, 'PATCH', { text }).then(done)" @delete="done => messageAction(message, 'DELETE').then(done)" @react="messageAction(message, 'POST', { emoji: $event })" @reply="reply(message)" @quote="composer?.quote(message)" @jump="emit('jump', $event)" @copy-link="emit('copyLink', message)" />
      </template>
    </MessageTimeline>
    <ChatComposer v-if="thread.data.value && permissions.includes('messages.send')" :can-attach="permissions.includes('attachments.upload')" ref="composer" :user-id="user.id" :workspace-id="workspaceId" :channel-id="channelId" :thread-id="threadId" :channel-name="thread.data.value.thread.name" :reply-to="replyTo" :typing="typing" @clear-reply="replyTo = null" @typing="emit('typing', $event)" @sent="latestMessages" @layout="emit('layout', $event)" />
  </aside>
</template>

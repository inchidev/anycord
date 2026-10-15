<script setup lang="ts">
const api = apiFor(), uploadFile = uploadFor()
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { useThrottleFn, useResizeObserver, useMediaQuery } from '@vueuse/core'
import { MAX_ATTACHMENT_BYTES, type Message } from '../../shared/contracts'
import { parseSlashCommand, CommandInputError } from '../../shared/apps'
import { quoteMessage } from '../../shared/message-text'
import { getApiTarget } from '../utils/connection'
import { prepareAttempt, type MessageAttempt } from '../../shared/drafts'
import { apiFor, uploadFor } from '../utils/api'
import { receiveMessage } from '../data/messages'
const props = defineProps<{ userId: string; workspaceId: string; channelId: string; channelName: string; threadId?: string; replyTo?: Message | null; typing?: string; ai?: boolean; huddle?: boolean; huddlePending?: boolean }>()
const emit = defineEmits<{ clearReply: []; sent: []; typing: [event: { type: 'typing'; channelId: string; threadId?: string }]; askAi: []; startHuddle: []; layout: [metrics: { bottom: number; height: number }] }>()
const queryClient = useQueryClient(), toast = useToast()
const commandRegistry = useQuery({ queryKey: computed(() => ['commands', props.workspaceId, props.channelId]), queryFn: () => api('commands', { params: { channelId: props.channelId } }), enabled: computed(() => !!props.channelId && !props.threadId) })
const commandFeedback = ref(''), commandFailure = ref('')
const pendingInvocation = ref<{ id: string; channelId: string } | null>(null)
const commandResult = useQuery({ queryKey: computed(() => ['command-result', props.userId, pendingInvocation.value?.id]),
  queryFn: () => api('commandResult', { params: { channelId: pendingInvocation.value!.channelId, invocationId: pendingInvocation.value!.id } }),
  enabled: computed(() => !!pendingInvocation.value), refetchInterval: query => query.state.data?.status === 'pending' ? 2000 : false,
})
watch(commandResult.data, result => {
  if (!result || result.status === 'pending') return
  commandFeedback.value = result.status === 'completed' ? 'Command completed.' : ''
  commandFailure.value = result.error || ''
})
watch(commandResult.error, error => { if (error) commandFailure.value = apiError(error) })

const draftScope = getApiTarget().origin
const { $draftStore } = useNuxtApp()
const drafts = computed(() => $draftStore(props.userId, draftScope))
const key = computed(() => `${props.channelId}:${props.threadId || 'main'}`)
const draft = computed({ get: () => drafts.value[key.value]?.text || '', set: (value: string) => { drafts.value[key.value] = { ...drafts.value[key.value], text: value } } })
const activeReply = computed(() => drafts.value[key.value]?.reply)
const pending = useState<Record<string, boolean>>('anycord-pending-sends', () => ({}))
const pendingKey = computed(() => `${draftScope}:${props.userId}:${key.value}`)
const isPending = computed(() => !!pending.value[pendingKey.value])
watch(() => props.replyTo, (message) => {
  if (message && message.channelId === props.channelId && message.threadId === (props.threadId || null)) {
    drafts.value[key.value] = { ...drafts.value[key.value], text: draft.value, reply: { id: message.id, author: message.author, text: message.text, channelId: message.channelId, threadId: message.threadId } }
  }
})
const isMobile = useMediaQuery('(max-width: 700px)')
const surface = useTemplateRef<HTMLElement>('surface')
function measure() {
  const box = surface.value?.querySelector('.composer-box')?.getBoundingClientRect()
  if (box) emit('layout', { bottom: window.innerHeight - box.bottom, height: box.height })
}
useResizeObserver(surface, measure)
const emojiOpen = ref(false)
const files = computed(() => drafts.value[key.value]?.attachments || [])
const uploading = ref(false), uploadError = ref(''), pickerRevision = ref(0)
async function addFiles(selected: File[] | File | null | undefined) {
  if (!selected || uploading.value || isPending.value) return
  if (!navigator.onLine) { uploadError.value = 'Reconnect before attaching files.'; return }
  const list = Array.isArray(selected) ? selected : [selected]
  const context = key.value, owner = props.userId, channelId = props.channelId
  const store = $draftStore(owner, draftScope)
  if (list.length + (store[context]?.attachments?.length || 0) > 4) { uploadError.value = 'Up to four files per message.'; return }
  uploading.value = true; uploadError.value = ''
  try {
    for (const file of list) {
      if (!file.size || file.size > MAX_ATTACHMENT_BYTES) throw new Error('Each file must be between 1 byte and 8 MB.')
      const created = await api('attachmentCreate', { params: { channelId }, body: { name: file.name, size: file.size } })
      try {
        const uploaded = await uploadFile(created.id, file)
        store[context] = { ...store[context], text: store[context]?.text || '', attachments: [...(store[context]?.attachments || []), uploaded] }
      } catch (cause) { await api('attachmentDelete', { params: { attachmentId: created.id } }).catch(() => undefined); throw cause }
    }
  } catch (cause) { uploadError.value = apiError(cause) }
  finally { uploading.value = false; pickerRevision.value++ }
}
async function removeFile(id: string) {
  if (isPending.value) return
  const state = drafts.value[key.value]
  if (state?.attachments) state.attachments = state.attachments.filter(f => f.id !== id)
  await api('attachmentDelete', { params: { attachmentId: id } }).catch(() => undefined)
}
function paste(event: ClipboardEvent) { if (event.clipboardData?.files.length) { event.preventDefault(); void addFiles([...event.clipboardData.files]) } }
function drop(event: DragEvent) { if (event.dataTransfer?.files.length) void addFiles([...event.dataTransfer.files]) }

type Attempt = MessageAttempt & { draftKey: string; pendingKey: string; ownerId: string; workspaceId: string }
let disposed = false
onBeforeUnmount(() => { disposed = true })
const send = useMutation({
  mutationFn: async (attempt: Attempt) => {
    if (attempt.text.startsWith('/')) {
      if (attempt.threadId || attempt.replyToId || attempt.attachmentIds?.length) throw new CommandInputError('Run slash commands in a channel without a reply or attachments')
      const registry = await api('commands', { params: { channelId: attempt.channelId } })
      const command = parseSlashCommand(attempt.text, registry)
      const result = await api('commandInvoke', { params: { channelId: attempt.channelId }, body: { id: attempt.id, ...command } })
      if (result.status === 'failed' || result.status === 'cancelled') throw new CommandInputError(result.error || 'Command failed')
      if (!disposed && key.value === attempt.draftKey && props.userId === attempt.ownerId) {
        commandFeedback.value = result.status === 'pending' ? 'Command accepted. The app will respond here.' : ''
        pendingInvocation.value = result.status === 'pending' ? { id: result.id, channelId: attempt.channelId } : null
      }
      return result.message
    }
    return api('messageCreate', { params: { channelId: attempt.channelId }, body: { id: attempt.id, text: attempt.text, threadId: attempt.threadId, replyToId: attempt.replyToId, attachmentIds: attempt.attachmentIds } })
  },
  onSuccess: async (message, attempt) => {
    if (message && props.userId === attempt.ownerId) await receiveMessage(queryClient, { userId: attempt.ownerId, workspaceId: attempt.workspaceId }, message)
    const store = $draftStore(attempt.ownerId, draftScope)
    if (store[attempt.draftKey]?.text.trim() === attempt.text && store[attempt.draftKey]?.attempt?.id === attempt.id && store[attempt.draftKey]?.reply?.id === attempt.replyToId) delete store[attempt.draftKey]
    else if (store[attempt.draftKey]?.attachments) store[attempt.draftKey]!.attachments = store[attempt.draftKey]!.attachments!.filter(file => !attempt.attachmentIds?.includes(file.id))
    if (!disposed && props.userId === attempt.ownerId && key.value === attempt.draftKey) { if (props.replyTo?.id === attempt.replyToId) emit('clearReply'); emit('sent'); focus() }
    if (attempt.threadId) await queryClient.invalidateQueries({ queryKey: ['messages', attempt.channelId] })
    await queryClient.invalidateQueries({ queryKey: ['threads', attempt.channelId] })
  },
  onSettled: (_data, _error, attempt) => { delete pending.value[attempt.pendingKey] },
})
function submit() {
  commandFeedback.value = ''; commandFailure.value = ''
  if (!navigator.onLine) { toast.add({ title: 'You’re offline. Reconnect to send. Your draft is kept.', color: 'warning' }); return }
  if ((!draft.value.trim() && !files.value.length) || uploading.value || isPending.value || !props.channelId) return
  const input = { text: draft.value.trim(), channelId: props.channelId, threadId: props.threadId, replyToId: activeReply.value?.id, attachmentIds: files.value.map(f => f.id) }
  const attempt = prepareAttempt(drafts.value[key.value]?.attempt, input)
  drafts.value[key.value] = { ...drafts.value[key.value], text: draft.value, attempt }
  pending.value[pendingKey.value] = true
  send.mutate({ ...attempt, draftKey: key.value, pendingKey: pendingKey.value, ownerId: props.userId, workspaceId: props.workspaceId })
}
function focus() { surface.value?.querySelector('textarea')?.focus({ preventScroll: true }) }
async function insertText(text: string) {
  const input = surface.value?.querySelector('textarea')
  const start = input?.selectionStart ?? draft.value.length, end = input?.selectionEnd ?? start
  const next = draft.value.slice(0, start) + text + draft.value.slice(end)
  if (next.length > 4000) { toast.add({ title: 'This would exceed the 4,000 character limit.', color: 'error' }); return }
  draft.value = next; emojiOpen.value = false
  await nextTick(); focus(); input?.setSelectionRange(start + text.length, start + text.length)
}
function quote(message: Message) { return insertText(quoteMessage(message.author, message.text)) }
const notifyTyping = useThrottleFn(() => { if (draft.value.trim()) emit('typing', { type: 'typing', channelId: props.channelId, ...(props.threadId ? { threadId: props.threadId } : {}) }) }, 1800)
watch(draft, () => notifyTyping())
watch(key, () => { send.reset(); commandFeedback.value = ''; commandFailure.value = ''; pendingInvocation.value = null })
function clearReply() {
  const state = drafts.value[key.value]
  if (state) delete state.reply
  emit('clearReply')
}
function keydown(event: KeyboardEvent) {
  if (!isMobile.value && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit() }
  if (event.key === 'Escape' && activeReply.value) { event.stopPropagation(); clearReply() }
}
defineExpose({ focus, quote, measure })
</script>

<template>
  <form ref="surface" class="message-composer" :data-uploading="uploading" @submit.prevent="submit" @paste="paste" @dragover.prevent @drop.prevent="drop">
    <div v-if="activeReply" class="reply-composer"><span>Replying to <strong>{{ activeReply.author }}</strong><small>{{ activeReply.text }}</small></span><UButton icon="i-lucide-x" color="neutral" variant="ghost" aria-label="Cancel reply" @click="clearReply" /></div>
    <div v-if="files.length" class="attachment-drafts"><div v-for="file in files" :key="file.id"><UIcon name="i-lucide-file" /><span>{{ file.name }}</span><UButton icon="i-lucide-x" variant="ghost" color="neutral" :aria-label="`Remove ${file.name}`" :disabled="isPending" @click="removeFile(file.id)" /></div></div>
    <p v-if="uploading" class="attachment-loading" role="status">Uploading file…</p><p v-if="uploadError" class="send-error" role="alert">{{ uploadError }}</p>
    <div v-if="draft.startsWith('/') && !threadId" class="max-h-44 overflow-auto rounded border border-default bg-elevated p-2" aria-label="Available commands">
      <p v-if="commandRegistry.isPending.value" class="text-sm">Loading commands…</p>
      <p v-else-if="commandRegistry.isError.value" class="text-sm">Could not load commands.</p>
      <p v-else-if="!commandRegistry.data.value?.length" class="text-sm">No commands here. Ask the server owner to install an app.</p>
      <div v-for="command in commandRegistry.data.value || []" :key="`${command.appId}:${command.name}`" class="py-1">
        <UButton color="neutral" variant="ghost" size="sm" @click="draft = `/${command.name}${(commandRegistry.data.value || []).filter(c => c.name === command.name).length > 1 ? `@${command.appId}` : ''} `; focus()">/{{ command.name }} · {{ command.appName }}</UButton>
        <span class="text-sm text-muted">{{ command.description }} {{ command.arguments.map(a => a.required ? `<${a.name}: ${a.type}>` : `[${a.name}: ${a.type}]`).join(' ') }}</span>
      </div>
      <p v-if="commandRegistry.data.value?.length" class="text-xs text-muted">Arguments follow the command in order. Use double quotes for spaces.</p>
    </div>
    <div class="composer-box">
      <UFileUpload :key="pickerRevision" :multiple="true" :disabled="uploading || isPending || !channelId" class="attachment-picker" @update:model-value="addFiles"><template #default="{ open }"><UButton :icon="isMobile ? 'i-lucide-plus' : 'i-lucide-circle-plus'" color="neutral" variant="ghost" aria-label="Attach files" :disabled="uploading || isPending || !channelId" @click="open()" /></template></UFileUpload>
      <UTextarea :disabled="!channelId" v-model="draft" :placeholder="threadId ? `Message ${channelName}` : `Message #${channelName}`" :rows="1" :maxrows="6" autoresize :maxlength="4000" variant="none" class="composer-input" aria-label="Message" @keydown="keydown" />
      <UTooltip v-if="ai" text="Ask AI (shares the last 12 channel messages)"><UButton class="composer-ai" icon="i-lucide-bot" color="neutral" variant="ghost" aria-label="Ask AI about this conversation" @click="emit('askAi')" /></UTooltip>
      <UPopover v-model:open="emojiOpen"><UButton icon="i-lucide-smile" color="neutral" variant="ghost" aria-label="Insert emoji" /><template #content><EmojiPicker @select="insertText" /></template></UPopover>
      <UTooltip v-if="isMobile && huddle && !draft.trim() && !files.length" text="Start a voice huddle"><UButton icon="i-lucide-mic" color="neutral" variant="ghost" aria-label="Start a voice huddle" :loading="huddlePending" :disabled="!channelId" @click="emit('startHuddle')" /></UTooltip>
      <UButton v-if="draft.trim() || files.length" :disabled="uploading" type="submit" icon="i-lucide-send-horizontal" :loading="isPending" aria-label="Send message" />
    </div>
    <div class="composer-status" :class="{ 'has-status': send.isError.value || typing || commandFeedback || commandFailure }" role="status"><span v-if="send.isError.value" class="send-error">{{ send.error.value instanceof CommandInputError ? send.error.value.message : apiError(send.error.value) }} <button type="button" @click="submit">Retry</button></span><span v-else-if="commandFailure" class="send-error">{{ commandFailure }}</span><span v-else-if="commandFeedback">{{ commandFeedback }}</span><span v-else-if="typing">{{ typing }}…</span><span v-else>Shift + Enter for a new line</span></div>
  </form>
</template>

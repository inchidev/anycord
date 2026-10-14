<script setup lang="ts">
import type { Message } from '../../shared/contracts'
const props = withDefaults(defineProps<{ message: Message; mine: boolean; canDelete: boolean; allowThread?: boolean; replyable?: boolean }>(), { allowThread: true, replyable: true })
const emit = defineEmits<{ edit: [text: string, done: (success: boolean) => void]; delete: [done: (success: boolean) => void]; react: [emoji: string]; reply: []; quote: []; thread: []; jump: [id: string]; copyLink: [] }>()
let movedMenuFocus = false
function menuFocus(event: Event) { if (movedMenuFocus) { event.preventDefault(); movedMenuFocus = false } }
const editing = ref(false)
const editText = ref('')
const deleting = ref(false)
const editPending = ref(false), editError = ref('')
const reactionOpen = ref(false), deletePending = ref(false), deleteError = ref('')
const menu = computed(() => [
  ...(props.replyable ? [{ label: 'Reply', icon: 'i-lucide-reply', onSelect: () => { movedMenuFocus = true; emit('reply') } }] : []),
  { label: 'Quote', icon: 'i-lucide-quote', onSelect: () => { movedMenuFocus = true; emit('quote') } },
  ...(props.allowThread && !props.message.threadId ? [{ label: props.message.thread ? 'Open Thread' : 'Create Thread', icon: 'i-lucide-messages-square', onSelect: () => { movedMenuFocus = true; emit('thread') } }] : []),
  { label: 'Copy Message Link', icon: 'i-lucide-link', onSelect: () => emit('copyLink') },
  ...(props.mine ? [{ label: 'Edit Message', icon: 'i-lucide-pencil', onSelect: () => { editText.value = props.message.text; editing.value = true } }] : []),
  ...(props.canDelete ? [{ label: 'Delete Message', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => { deleting.value = true } }] : []),
])
function remove() {
  if (deletePending.value) return
  deletePending.value = true; deleteError.value = ''
  emit('delete', (success) => { deletePending.value = false; if (success) deleting.value = false; else deleteError.value = 'Could not delete the message. Try again.' })
}
function react(emoji: string) { emit('react', emoji); reactionOpen.value = false }
function save() {
  if (!editText.value.trim() || editPending.value) return
  editPending.value = true; editError.value = ''
  emit('edit', editText.value.trim(), (success) => {
    editPending.value = false
    if (success) editing.value = false
    else editError.value = 'Could not save. Your changes are still here; try again.'
  })
}
</script>

<template>
  <article class="message-row" :class="{ 'has-reply': message.replyToId }" :id="`message-${message.id}`" tabindex="0">
    <span class="avatar" :style="{ backgroundColor: message.color }" aria-hidden="true">{{ message.author.slice(0, 2).toUpperCase() }}</span>
    <div class="message-content">
      <button v-if="message.replyToId" class="reply-preview" :disabled="!message.reply" @click="emit('jump', message.replyToId)"><UIcon name="i-lucide-corner-up-right" /><strong v-if="message.reply">{{ message.reply.author }}</strong><span>{{ message.reply?.text || 'Original message was deleted' }}</span></button>
      <header><strong :style="{ color: message.bot ? '#f2f3f5' : message.color }">{{ message.author }}</strong><span v-if="message.bot" class="bot-label">APP</span><time :datetime="new Date(message.createdAt).toISOString()" :title="new Date(message.createdAt).toLocaleString()">{{ new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }}</time></header>
      <template v-if="editing">
        <UTextarea v-model="editText" :rows="2" autoresize class="w-full" aria-label="Edit message" :maxlength="4000" :disabled="editPending" />
        <p v-if="editError" role="alert" class="edit-error">{{ editError }}</p>
        <div class="edit-hint"><button :disabled="editPending" @click="editing = false">Cancel</button> · <button :disabled="editPending" @click="save">{{ editPending ? 'Saving…' : 'Save changes' }}</button></div>
      </template>
      <MessageText v-else :text="message.text"><small v-if="message.editedAt" class="edited">(edited)</small></MessageText>
      <div v-if="message.attachments.length" class="message-attachments"><MessageAttachment v-for="file in message.attachments" :key="file.id" :file="file" /></div>
      <div v-if="message.reactions.length" class="reactions">
        <button v-for="reaction in message.reactions" :key="reaction.emoji" :class="{ mine: reaction.mine }" :aria-pressed="reaction.mine" :aria-label="`${reaction.emoji}, ${reaction.count} reactions`" @click="emit('react', reaction.emoji)">{{ reaction.emoji }} <span>{{ reaction.count }}</span></button>
      </div>
      <button v-if="message.thread && allowThread" class="thread-preview" @click="emit('thread')"><UIcon name="i-lucide-messages-square" /><strong>{{ message.thread.name }}</strong><span>{{ message.thread.messageCount }} {{ message.thread.messageCount === 1 ? 'message' : 'messages' }}</span><UIcon name="i-lucide-chevron-right" /></button>
    </div>
    <div class="message-actions">
      <UPopover v-model:open="reactionOpen"><UButton icon="i-lucide-smile-plus" variant="ghost" color="neutral" aria-label="Add reaction" /><template #content><EmojiPicker @select="react" /></template></UPopover>
      <UButton v-if="replyable" icon="i-lucide-reply" variant="ghost" color="neutral" aria-label="Reply to message" @click="emit('reply')" />
      <UDropdownMenu v-if="menu.length" :items="menu" :content="{ onCloseAutoFocus: menuFocus }"><UButton icon="i-lucide-ellipsis" variant="ghost" color="neutral" aria-label="Message actions" /></UDropdownMenu>
    </div>
    <UModal v-model:open="deleting" title="Delete Message" description="This message will be permanently deleted."><template #body><p class="delete-preview">{{ message.text }}</p><UAlert v-if="deleteError" color="error" :title="deleteError" /></template><template #footer><UButton color="neutral" variant="ghost" :disabled="deletePending" @click="deleting = false">Cancel</UButton><UButton color="error" :loading="deletePending" @click="remove">Delete</UButton></template></UModal>
  </article>
</template>

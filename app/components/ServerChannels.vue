<script setup lang="ts">
const api = apiFor()
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { channelUpdateSchema, type Channel, type Member } from '../../shared/contracts'
import { can } from '../../shared/permissions'
import { apiFor } from '../utils/api'
const props = defineProps<{ channels: Channel[]; owner: boolean; members: Member[] }>()
const queryClient = useQueryClient()
const selectedId = ref(props.channels[0]?.id || '')
const selected = computed(() => props.channels.find(item => item.id === selectedId.value))
type Fields = { name: string; topic: string }
const drafts = reactive<Record<string, { state: Fields; baseline: Fields }>>({})
function fields(channel: Channel): Fields { return { name: channel.name, topic: channel.topic } }
watch(() => props.channels, (channels) => {
  for (const channel of channels) {
    const draft = drafts[channel.id]
    if (!draft) drafts[channel.id] = { state: fields(channel), baseline: fields(channel) }
    else if (draft.state.name === draft.baseline.name && draft.state.topic === draft.baseline.topic) {
      Object.assign(draft.state, fields(channel)); Object.assign(draft.baseline, fields(channel))
    }
  }
  if (!channels.some(channel => channel.id === selectedId.value)) selectedId.value = channels[0]?.id || ''
}, { immediate: true })
const state = computed(() => drafts[selectedId.value]?.state || { name: '', topic: '' })
const baseline = computed(() => drafts[selectedId.value]?.baseline || { name: '', topic: '' })
const feedback = ref('')
const dirty = computed(() => state.value.name !== baseline.value.name || state.value.topic !== baseline.value.topic)
watch(selectedId, () => { feedback.value = '' })
const save = useMutation({
  mutationFn: (input: { id: string; name: string; topic: string }) => api('channelUpdate', { params: { channelId: input.id }, body: { name: input.name, topic: input.topic } }),
  onSuccess: async (channel) => {
    const draft = drafts[channel.id]
    if (draft) { Object.assign(draft.state, fields(channel)); Object.assign(draft.baseline, fields(channel)) }
    if (channel.id === selectedId.value) feedback.value = 'Channel settings saved.'
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['bootstrap'] }), queryClient.invalidateQueries({ queryKey: ['search'] })])
  },
})
function select(id: string) { selectedId.value = id; save.reset() }
function reset() { if (selected.value) { Object.assign(state.value, fields(selected.value)); Object.assign(baseline.value, state.value) } feedback.value = ''; save.reset() }
</script>
<template>
  <h2>Channels</h2><p class="section-description">Choose a channel to edit its name and topic.</p>
  <div class="settings-channel-list" aria-label="Choose a channel"><button v-for="channel in channels" :key="channel.id" :class="{ active: selectedId === channel.id }" :aria-pressed="selectedId === channel.id" :disabled="save.isPending.value" @click="select(channel.id)"><UIcon :name="channel.kind === 'voice' ? 'i-lucide-volume-2' : 'i-lucide-hash'" /><span>{{ channel.name }}</span></button></div>
  <UAlert v-if="!can(selected, 'channels.manage')" color="info" title="You need Manage channels to change this channel." />
  <UForm v-if="selected" :key="selectedId" :schema="channelUpdateSchema" :state="state" class="server-overview-form" @submit="feedback = ''; save.mutate({ id: selectedId, ...state })">
    <UFormField name="name" label="CHANNEL NAME"><UInput v-model="state.name" aria-label="Channel name" :maxlength="40" :disabled="!can(selected, 'channels.manage') || save.isPending.value" class="w-full" /></UFormField>
    <UFormField name="topic" label="CHANNEL TOPIC" description="Let people know what this channel is for."><UTextarea v-model="state.topic" aria-label="Channel topic" :maxlength="200" :rows="3" :disabled="!can(selected, 'channels.manage') || save.isPending.value" class="w-full" /></UFormField>
    <UAlert v-if="save.isError.value" color="error" :title="apiError(save.error.value)" /><p v-if="feedback" class="settings-feedback" role="status">{{ feedback }}</p>
    <div v-if="can(selected, 'channels.manage')" class="settings-save-row"><span>{{ dirty ? 'You have unsaved changes.' : 'All changes saved.' }}</span><UButton variant="ghost" color="neutral" :disabled="!dirty || save.isPending.value" @click="reset">Reset</UButton><UButton type="submit" :disabled="!dirty" :loading="save.isPending.value">Save Changes</UButton></div>
  </UForm>
  <ChannelPermissions v-if="selected && can(selected, 'channels.permissions')" :key="selected.id" :channel="selected" :members="members" />
</template>

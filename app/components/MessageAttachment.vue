<script setup lang="ts">
const api = apiFor(), targetOrigin = getApiTarget().origin
import { useQuery } from '@tanstack/vue-query'
import type { Message } from '../../shared/contracts'
import { getApiTarget } from '../utils/connection'
import { apiFor } from '../utils/api'
const props = defineProps<{ file: Message['attachments'][number] }>()
const download = useQuery({ queryKey: computed(() => ['attachment', props.file.id]), queryFn: () => api('attachmentDownload', { params: { attachmentId: props.file.id } }), staleTime: 240_000, refetchInterval: 240_000, retry: 1 })
const url = computed(() => download.data.value?.url ? targetOrigin + download.data.value.url : undefined)
const preview = ref(false), imageError = ref(false)
const size = computed(() => props.file.size < 1024 * 1024 ? `${Math.ceil(props.file.size / 1024)} KB` : `${(props.file.size / 1024 / 1024).toFixed(1)} MB`)
watch(url, () => { imageError.value = false })
</script>
<template>
  <div class="message-attachment">
    <button v-if="url && file.contentType.startsWith('image/') && !imageError" class="attachment-image" :aria-label="`Preview ${file.name}`" @click="preview = true"><img :src="url" :alt="file.name" loading="lazy" @error="imageError = true" /></button>
    <a v-if="url" class="attachment-file" :href="url" target="_blank" rel="noopener noreferrer" :download="file.name"><UIcon :name="file.contentType.startsWith('image/') ? 'i-lucide-image' : 'i-lucide-file'" /><span>{{ file.name }}<small>{{ size }}</small></span><UIcon name="i-lucide-download" /></a>
    <span v-else-if="download.isPending.value" class="attachment-loading">Loading {{ file.name }}…</span><button v-else @click="download.refetch()">Retry {{ file.name }}</button>
    <button v-if="imageError" class="subtle-link" @click="download.refetch()">Refresh preview</button>
    <UModal v-model:open="preview" :title="file.name" description="Image preview" :ui="{ content: 'max-w-5xl' }"><template #body><img v-if="url" :src="url" :alt="file.name" class="attachment-lightbox" /></template></UModal>
  </div>
</template>

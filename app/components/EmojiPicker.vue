<script setup lang="ts">
import { emojiGroups } from '../../shared/emoji'
const emit = defineEmits<{ select: [emoji: string] }>()
const search = ref('')
const groups = computed(() => emojiGroups.map((group) => ({ name: group.name, items: group.items.filter(([emoji, name]) => `${emoji} ${name}`.includes(search.value.trim().toLowerCase())) })).filter((group) => group.items.length))
</script>

<template>
  <div class="emoji-browser">
    <UInput v-model="search" icon="i-lucide-search" placeholder="Find an emoji" aria-label="Find an emoji" autofocus class="w-full" />
    <div class="emoji-browser-scroll">
      <section v-for="group in groups" :key="group.name"><h3>{{ group.name }}</h3><div class="emoji-grid"><button v-for="[emoji, name] in group.items" :key="emoji" type="button" :title="name" :aria-label="name" @click="emit('select', emoji)">{{ emoji }}</button></div></section>
      <p v-if="!groups.length">No emoji found.</p>
    </div>
  </div>
</template>

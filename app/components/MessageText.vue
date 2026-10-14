<script setup lang="ts">
import { messageBlocks } from '../../shared/message-text'
const props = defineProps<{ text: string }>()
const blocks = computed(() => messageBlocks(props.text))
</script>
<template>
  <div class="message-text"><template v-for="(block, index) in blocks" :key="index"><blockquote v-if="block.quote">{{ block.text }}</blockquote><p v-else>{{ block.text }}</p></template><slot /></div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ wordmark?: boolean }>(), { wordmark: false })
</script>
<template><span class="anycord-brand"><img src="/brand/anycord-symbol.png" alt="" width="40" height="40" /><strong v-if="wordmark">Anycord</strong></span></template>

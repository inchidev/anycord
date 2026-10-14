<script setup lang="ts">
import { profileImage, profileInitials } from '../../shared/profile'
const props = defineProps<{ name: string; color?: string; src?: string | null }>()
const failed = ref(false)
watch(() => props.src, () => { failed.value = false })
const image = computed(() => profileImage(props.src))
</script>
<template><span class="avatar" :style="{ backgroundColor: color }" aria-hidden="true"><img v-if="image && !failed" :src="image" alt="" width="40" height="40" referrerpolicy="no-referrer" @error="failed = true" /><span v-else class="avatar-initials">{{ profileInitials(name) }}</span><slot /></span></template>

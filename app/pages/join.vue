<script setup lang="ts">
useHead({ title: 'Join a server · Anycord', meta: [{ name: 'referrer', content: 'no-referrer' }] })
</script>
<template><main class="auth-screen"><NuxtLink to="/servers" class="auth-brand"><BrandMark wordmark /></NuxtLink><section class="auth-card"><InvitationJoin login-next="/join" /></section></main></template>

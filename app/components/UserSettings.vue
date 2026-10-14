<script setup lang="ts">
import type { User } from '../../shared/contracts'
const open = defineModel<boolean>('open', { default: false })
defineProps<{ user: User }>()
const emit = defineEmits<{ logout: [] }>()
</script>
<template>
  <SettingsFrame v-model:open="open" title="User Settings" label="USER SETTINGS">
    <template #navigation><button class="active"><UIcon name="i-lucide-user-round" />My Account</button><hr /><button class="settings-logout" @click="emit('logout')">Log Out<UIcon name="i-lucide-log-out" /></button></template>
    <h2>My Account</h2>
    <div class="account-card">
      <div class="account-banner" :style="{ background: user.color }" />
      <div class="account-identity"><span class="avatar account-avatar" :style="{ background: user.color }">{{ user.name.slice(0, 2).toUpperCase() }}<i /></span><strong>{{ user.name }}</strong></div>
      <dl class="account-details"><div><dt>DISPLAY NAME</dt><dd>{{ user.name }}</dd></div><div><dt>ACCOUNT ROLE</dt><dd>{{ user.role === 'owner' ? 'Installation owner' : 'Member' }}</dd></div><div><dt>ACCOUNT</dt><dd>Account on this installation</dd></div></dl>
    </div>
    <div class="account-session"><h3>Account access</h3><p class="section-description">Sign out of this session on this device.</p><UButton color="error" variant="outline" @click="emit('logout')">Log Out</UButton></div>
  </SettingsFrame>
</template>

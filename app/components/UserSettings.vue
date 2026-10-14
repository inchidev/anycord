<script setup lang="ts">
import type { User, Channel } from '../../shared/contracts'
const open = defineModel<boolean>('open', { default: false })
defineProps<{ user: User; channels?: Channel[] }>()
const emit = defineEmits<{ logout: [] }>()
const tab = ref('account'), installationOpen = ref(false)
watch(open, value => { if (value) tab.value = 'account' })
</script>
<template>
  <SettingsFrame v-model:open="open" title="User Settings" label="USER SETTINGS">
    <template #navigation><button :class="{ active: tab === 'account' }" @click="tab = 'account'"><UIcon name="i-lucide-user-round" />My Account</button><button :class="{ active: tab === 'telegram' }" @click="tab = 'telegram'"><UIcon name="i-lucide-send" />Telegram</button><button :class="{ active: tab === 'recovery' }" @click="tab = 'recovery'"><UIcon name="i-lucide-key-round" />Recovery keys</button><button v-if="user.role === 'owner'" @click="open = false; installationOpen = true"><UIcon name="i-lucide-settings" />Installation Settings</button><hr /><button class="settings-logout" @click="emit('logout')">Log Out<UIcon name="i-lucide-log-out" /></button></template>
    <UserTelegramSettings v-if="tab === 'telegram' && open" :channels="channels" />
    <RecoverySettings v-if="tab === 'recovery' && open" />
    <template v-if="tab === 'account'">
    <h2>My Account</h2>
    <div class="account-card">
      <div class="account-banner" :style="{ background: user.color }" />
      <div class="account-identity"><span class="avatar account-avatar" :style="{ background: user.color }">{{ user.name.slice(0, 2).toUpperCase() }}<i /></span><strong>{{ user.name }}</strong></div>
      <dl class="account-details"><div><dt>DISPLAY NAME</dt><dd>{{ user.name }}</dd></div><div><dt>ACCOUNT ROLE</dt><dd>{{ user.role === 'owner' ? 'Installation owner' : 'Member' }}</dd></div><div><dt>ACCOUNT</dt><dd>Account on this installation</dd></div></dl>
    </div>
    <div class="account-session"><h3>Account access</h3><p class="section-description">Sign out of this session on this device.</p><UButton color="error" variant="outline" @click="emit('logout')">Log Out</UButton></div>
    <UAlert class="mt-5" color="info" title="Keep your account recoverable" description="Save recovery keys before you need them. Email recovery is not available yet." /><UButton class="mt-3" color="neutral" variant="outline" @click="tab = 'recovery'">Manage recovery keys</UButton>
    </template>
  </SettingsFrame>
  <InstallationSettings v-if="user.role === 'owner' && installationOpen" v-model:open="installationOpen" />
</template>

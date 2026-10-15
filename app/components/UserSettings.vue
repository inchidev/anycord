<script setup lang="ts">
import type { User, Channel } from '../../shared/contracts'
import { getApiTarget } from '../utils/connection'
const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{ user: User; channels?: Channel[]; initialScope?: 'account' | 'installation'; initialInstallationTab?: 'authentication' | 'integrations' | 'storage' | 'database' | 'operations' }>()
const emit = defineEmits<{ logout: [] }>()
const host = new URL(getApiTarget().origin || window.location.origin).host
const scope = ref<'account' | 'installation'>('account')
const tab = ref('account')
const installationTab = ref<'authentication' | 'integrations' | 'storage' | 'database' | 'operations'>('authentication')
watch(open, value => {
  if (value) { scope.value = props.user.role === 'owner' && props.initialScope === 'installation' ? 'installation' : 'account'; tab.value = 'account'; installationTab.value = props.initialInstallationTab || 'authentication' }
}, { immediate: true })
</script>
<template>
  <SettingsFrame v-model:open="open" :title="scope === 'installation' ? 'Installation Settings' : 'User Settings'" :label="scope === 'installation' ? 'INSTALLATION OWNER' : 'YOUR ACCOUNT'" :description="scope === 'installation' ? `Administration for ${host}. Changes apply to every community on this installation.` : `${user.name} · ${host}. Personal settings for this account.`">
    <template #navigation>
      <template v-if="scope === 'account'">
        <button :class="{ active: tab === 'account' }" @click="tab = 'account'"><UIcon name="i-lucide-user-round" />My Account</button>
        <button :class="{ active: tab === 'telegram' }" @click="tab = 'telegram'"><UIcon name="i-lucide-send" />Telegram</button>
        <button :class="{ active: tab === 'recovery' }" @click="tab = 'recovery'"><UIcon name="i-lucide-key-round" />Recovery keys</button>
        <hr /><button v-if="user.role === 'owner'" @click="scope = 'installation'"><UIcon name="i-lucide-globe" />Installation Settings</button>
        <button class="settings-logout" @click="emit('logout')">Log Out<UIcon name="i-lucide-log-out" /></button>
      </template>
      <template v-else>
        <button @click="scope = 'account'"><UIcon name="i-lucide-arrow-left" />Back to User Settings</button><hr />
        <button :class="{ active: installationTab === 'authentication' }" @click="installationTab = 'authentication'"><UIcon name="i-lucide-shield-check" />Authentication</button>
        <button :class="{ active: installationTab === 'integrations' }" @click="installationTab = 'integrations'"><UIcon name="i-lucide-plug" />Integrations</button>
        <button :class="{ active: installationTab === 'storage' }" @click="installationTab = 'storage'"><UIcon name="i-lucide-hard-drive" />File storage</button>
        <button :class="{ active: installationTab === 'database' }" @click="installationTab = 'database'"><UIcon name="i-lucide-database" />Database</button>
        <button :class="{ active: installationTab === 'operations' }" @click="installationTab = 'operations'"><UIcon name="i-lucide-archive" />Backups &amp; updates</button>
      </template>
    </template>
    <InstallationSettings v-if="scope === 'installation' && user.role === 'owner' && open" :tab="installationTab" />
    <template v-else-if="scope === 'account'">
    <UserTelegramSettings v-if="tab === 'telegram' && open" :channels="channels" />
    <RecoverySettings v-if="tab === 'recovery' && open" />
    <template v-if="tab === 'account'">
    <h2>My Account</h2>
    <div class="account-card">
      <div class="account-banner" :style="{ background: user.color }" />
      <div class="account-identity"><UserAvatar class="account-avatar" :name="user.name" :color="user.color" :src="user.avatarUrl"><i /></UserAvatar><strong>{{ user.name }}</strong></div>
      <dl class="account-details"><div><dt>DISPLAY NAME</dt><dd>{{ user.name }}</dd></div><div><dt>ACCOUNT ROLE</dt><dd>{{ user.role === 'owner' ? 'Installation owner' : 'Member' }}</dd></div><div><dt>ACCOUNT</dt><dd>Account on this installation</dd></div></dl>
    </div>
    <div class="account-session"><h3>Account access</h3><p class="section-description">Sign out of this session on this device.</p><UButton color="error" variant="outline" @click="emit('logout')">Log Out</UButton></div>
    <UAlert class="mt-5" color="info" title="Keep your account recoverable" description="Save recovery keys before you need them. Email recovery is not available yet." /><UButton class="mt-3" color="neutral" variant="outline" @click="tab = 'recovery'">Manage recovery keys</UButton>
    </template>
    </template>
  </SettingsFrame>
</template>

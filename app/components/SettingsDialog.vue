<script setup lang="ts">
import type { Workspace, Channel, Member } from '../../shared/contracts'
const open = defineModel<boolean>('open', { default: false })
defineProps<{ owner: boolean; workspace?: Workspace; channels: Channel[]; members: Member[] }>()
const tab = ref('overview')
watch(open, value => { if (value) tab.value = 'overview' })
</script>
<template>
  <SettingsFrame v-model:open="open" title="Server Settings" :label="workspace?.name || 'SERVER SETTINGS'">
    <template #navigation><button :class="{ active: tab === 'overview' }" @click="tab = 'overview'"><UIcon name="i-lucide-sliders-horizontal" />Overview</button><button :class="{ active: tab === 'channels' }" @click="tab = 'channels'"><UIcon name="i-lucide-hash" />Channels</button><button :class="{ active: tab === 'members' }" @click="tab = 'members'"><UIcon name="i-lucide-users-round" />Members</button><button v-if="workspace?.role === 'owner'" :class="{ active: tab === 'invites' }" @click="tab = 'invites'"><UIcon name="i-lucide-user-plus" />Invitations</button></template>
    <ServerOverview v-if="tab === 'overview' && workspace" :key="workspace.id" :workspace="workspace" />
    <ServerChannels v-if="tab === 'channels'" :key="workspace?.id" :channels="channels" :owner="workspace?.role === 'owner'" />
    <ServerMembers v-if="tab === 'members' && workspace" :key="workspace.id" :workspace="workspace" :members="members" />
    <InvitationSettings v-if="tab === 'invites' && workspace?.role === 'owner'" :key="workspace.id" :workspace-id="workspace.id" />
  </SettingsFrame>
</template>

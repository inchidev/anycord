<script setup lang="ts">
import { can } from '../../shared/permissions'
import type { Workspace, Channel, Member } from '../../shared/contracts'
const open = defineModel<boolean>('open', { default: false })
defineProps<{ owner: boolean; workspace?: Workspace; channels: Channel[]; members: Member[] }>()
const tab = ref('overview')
watch(open, value => { if (value) tab.value = 'overview' })
</script>
<template>
  <SettingsFrame v-model:open="open" title="Server Settings" :label="workspace?.name || 'SERVER SETTINGS'" :description="`Community settings for ${workspace?.name || 'this server'}.`">
    <template #navigation><button :class="{ active: tab === 'overview' }" @click="tab = 'overview'"><UIcon name="i-lucide-sliders-horizontal" />Overview</button><button :class="{ active: tab === 'channels' }" @click="tab = 'channels'"><UIcon name="i-lucide-hash" />Channels</button><button :class="{ active: tab === 'members' }" @click="tab = 'members'"><UIcon name="i-lucide-users-round" />Members</button><button v-if="can(workspace, 'invites.manage')" :class="{ active: tab === 'invites' }" @click="tab = 'invites'"><UIcon name="i-lucide-user-plus" />Invitations</button><button :class="{ active: tab === 'roles' }" @click="tab = 'roles'"><UIcon name="i-lucide-shield" />Roles</button><button v-if="can(workspace, 'audit.view')" :class="{ active: tab === 'audit' }" @click="tab = 'audit'"><UIcon name="i-lucide-history" />Audit log</button></template>
    <ServerOverview v-if="tab === 'overview' && workspace" :key="workspace.id" :workspace="workspace" />
    <ServerChannels v-if="tab === 'channels'" :key="workspace?.id" :channels="channels" :owner="can(workspace, 'channels.manage')" :members="members" />
    <ServerMembers v-if="tab === 'members' && workspace" :key="workspace.id" :workspace="workspace" :members="members" />
    <InvitationSettings v-if="tab === 'invites' && workspace && can(workspace, 'invites.manage')" :key="workspace.id" :workspace-id="workspace.id" />
    <ServerRoles v-if="tab === 'roles' && workspace" :key="workspace.id" :workspace="workspace" />
    <ServerAudit v-if="tab === 'audit' && workspace && can(workspace, 'audit.view')" :workspace-id="workspace.id" :members="members" />
  </SettingsFrame>
</template>

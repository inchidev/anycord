<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { telegramPreferencesInputSchema, credentialsSchema, type Channel } from '../../shared/contracts'
import { getApiTarget } from '../utils/connection'
import { miniAppSignIn, telegramInitData, telegramSignIn } from '../utils/telegram'
const props = defineProps<{ channels?: Channel[] }>()
const api = apiFor(), client = useQueryClient(), target = getApiTarget()
const account = useQuery({ queryKey: ['telegram-account'], queryFn: () => api('telegramAccount') })
const state = reactive({ enabled: false, preview: false, mutedChannelIds: [] as string[] })
const password = reactive({ name: '', password: '' }), error = ref(''), feedback = ref(''), linking = ref(false)
watch(account.data, data => { if (data) { state.enabled = data.enabled; state.preview = data.preview; state.mutedChannelIds = [...data.mutedChannelIds] } }, { immediate: true })
async function refresh() { await Promise.all([client.invalidateQueries({ queryKey: ['telegram-account'] }), client.invalidateQueries({ queryKey: ['auth'] }), client.invalidateQueries({ queryKey: ['bootstrap'] })]) }
const save = useMutation({ mutationFn: () => api('telegramPreferences', { body: state }), onSuccess: async () => { feedback.value = 'Telegram preferences saved.'; await refresh() }, onError: cause => { error.value = apiError(cause) } })
const unlink = useMutation({ mutationFn: () => api('telegramUnlink'), onSuccess: refresh, onError: cause => { error.value = apiError(cause) } })
const test = useMutation({ mutationFn: () => api('telegramTest'), onSuccess: () => { feedback.value = 'Test notification sent to Telegram.' }, onError: cause => { error.value = apiError(cause) } })
const setPassword = useMutation({ mutationFn: () => api('accountPassword', { body: { username: password.name, password: password.password } }), onSuccess: async () => { password.password = ''; feedback.value = 'Username/password added to this account.'; await Promise.all([refresh(), client.invalidateQueries({ queryKey: ['auth'] }), client.invalidateQueries({ queryKey: ['bootstrap'] })]) }, onError: cause => { error.value = apiError(cause) } })
async function link() {
  error.value = ''; linking.value = true
  try { if (telegramInitData() && account.data.value?.miniAppLogin) { await miniAppSignIn(true); await refresh() } else await telegramSignIn(true, '/servers') }
  catch (cause) { error.value = apiError(cause) }
  finally { linking.value = false }
}
function mute(channelId: string, value: boolean) { state.mutedChannelIds = value ? [...new Set([...state.mutedChannelIds, channelId])] : state.mutedChannelIds.filter(id => id !== channelId) }
</script>
<template>
  <h2>Telegram</h2><p class="section-description">Link Telegram to this account and choose which notifications you receive.</p>
  <UAlert v-if="account.isError.value" color="error" title="Could not load Telegram settings" />
  <UAlert v-if="error" color="error" :title="error" /><UAlert v-if="feedback" color="success" :title="feedback" />
  <template v-if="account.data.value">
    <div class="integration-form">
      <p>{{ account.data.value?.linked ? 'Telegram is linked to this account.' : 'Telegram is not linked.' }}</p>
      <UButton v-if="target.origin" :to="`${target.origin}/servers`" target="_blank" rel="noopener noreferrer" color="neutral" variant="outline">Open this installation to link Telegram</UButton>
      <UButton v-else-if="!account.data.value?.linked && (account.data.value?.browserLogin || account.data.value?.miniAppLogin)" :loading="linking" @click="link">Link Telegram</UButton>
      <p v-else-if="!account.data.value?.linked">The installation owner needs to enable Telegram login first.</p>
      <UButton v-if="account.data.value?.linked" color="error" variant="outline" :disabled="!account.data.value?.canUnlink" :loading="unlink.isPending.value" @click="error = ''; unlink.mutate()">Unlink Telegram</UButton>
      <p v-if="account.data.value?.linked && !account.data.value?.canUnlink" class="section-description">Keep another usable login method before unlinking Telegram.</p>
    </div>
    <UForm v-if="account.data.value?.canSetPassword" :schema="credentialsSchema" :state="password" class="integration-form" @submit="error = ''; feedback = ''; setPassword.mutate()">
      <h3>Add username and password</h3><p>Keep another way to access this same account.</p>
      <UFormField name="name" label="USERNAME" required><UInput v-model="password.name" autocomplete="username" class="w-full" /></UFormField><UFormField name="password" label="PASSWORD" required><UInput v-model="password.password" type="password" autocomplete="new-password" class="w-full" /></UFormField>
      <UButton type="submit" :loading="setPassword.isPending.value">Add password</UButton>
    </UForm>
    <UForm :schema="telegramPreferencesInputSchema" :state="state" class="integration-form" @submit="error = ''; feedback = ''; save.mutate()">
      <h3>Notifications</h3><p>Mentions, replies to your messages and activity in threads you follow. Previews are off by default.</p>
      <p v-if="!account.data.value?.notificationsAvailable">Telegram notifications are disabled for this installation.</p>
      <template v-if="account.data.value?.linked && account.data.value?.botUsername"><UButton :to="`https://t.me/${account.data.value?.botUsername}?start=notifications`" target="_blank" rel="noopener noreferrer" color="neutral" variant="outline">Start @{{ account.data.value?.botUsername }}</UButton><p>{{ account.data.value?.messagingAllowed ? 'Bot messaging access is connected.' : 'Start the bot, then refresh before enabling notifications.' }}</p><UButton color="neutral" variant="link" @click="account.refetch()">Refresh bot access</UButton></template>
      <UFormField name="enabled" label="Send Telegram notifications"><USwitch v-model="state.enabled" :disabled="!account.data.value?.linked || !account.data.value?.notificationsAvailable || !account.data.value?.messagingAllowed" /></UFormField>
      <UFormField name="preview" label="Include message previews"><USwitch v-model="state.preview" /></UFormField>
      <template v-if="props.channels?.length"><h4>Mute channels in this server</h4><UCheckbox v-for="channel in props.channels.filter(c => c.kind === 'text')" :key="channel.id" :model-value="state.mutedChannelIds.includes(channel.id)" :label="`#${channel.name}`" @update:model-value="mute(channel.id, $event === true)" /></template>
      <div class="integration-actions flex-wrap"><UButton type="submit" :loading="save.isPending.value">Save Preferences</UButton><UButton color="neutral" variant="outline" :disabled="!account.data.value?.enabled || save.isPending.value" :loading="test.isPending.value" @click="error = ''; feedback = ''; test.mutate()">Send test notification</UButton></div>
    </UForm>
  </template>
</template>

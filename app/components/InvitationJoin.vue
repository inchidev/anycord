<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { apiFor } from '../utils/api'
import { getApiTarget } from '../utils/connection'
import { invitationToken, pendingInvitationKey } from '../../shared/invitations'
import { serverPath } from '../../shared/navigation'

const props = defineProps<{ initialToken?: string; loginNext: '/invite' | '/join' }>()
const target = getApiTarget(), api = apiFor(target), client = useQueryClient()
const origin = target.origin || window.location.origin, host = new URL(origin).host
const storageKey = pendingInvitationKey(target.origin)
const auth = useAuthSession()
const input = ref(''), token = ref(''), error = ref(''), busy = ref(false)
try { token.value = props.initialToken || sessionStorage.getItem(storageKey) || '' } catch { token.value = props.initialToken || '' }
if (token.value && !/^[a-f0-9]{48}$/.test(token.value)) { token.value = ''; error.value = 'This invitation link is incomplete.' }
function remember() { try { if (token.value) sessionStorage.setItem(storageKey, token.value); else sessionStorage.removeItem(storageKey) } catch {} }
remember()
const preview = useQuery({ queryKey: computed(() => ['invite-preview', token.value]), queryFn: () => api('invitePreview', { body: { token: token.value } }), retry: false, enabled: computed(() => !!token.value) })
function check() {
  error.value = ''
  try { token.value = invitationToken(input.value, origin); input.value = ''; remember() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Paste a complete invitation link or invitation code.' }
}
function change() { token.value = ''; input.value = ''; error.value = ''; remember() }
async function join() {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    const result = await api('inviteAccept', { body: { token: token.value } })
    token.value = ''; remember()
    await client.invalidateQueries({ queryKey: ['server-picker'] })
    await navigateTo(serverPath(result.workspaceId))
  } catch (cause) { error.value = apiError(cause) } finally { busy.value = false }
}
function login(register: boolean) { remember(); return navigateTo({ path: '/login', query: { next: props.loginNext, ...(register ? { mode: 'register' } : {}) } }) }
function cancel() { change(); return navigateTo('/servers') }
</script>
<template>
  <div class="invitation-join space-y-5">
    <div><h1>{{ token ? 'You’re invited' : 'Join a server' }}</h1><p class="invitation-scope">Installation: <strong>{{ host }}</strong></p></div>
    <form v-if="!token" class="space-y-4" @submit.prevent="check">
      <p>Paste an invitation from a server owner to join a community on this installation.</p>
      <UFormField label="Invitation link or code" required><UInput v-model="input" placeholder="https://…/invite#token=…" autocomplete="off" :spellcheck="false" class="w-full" /></UFormField>
      <UButton type="submit" block :disabled="!input.trim()">Check invitation</UButton>
    </form>
    <UAlert v-else-if="preview.isError.value" color="error" :title="apiError(preview.error.value)" />
    <p v-else-if="preview.isPending.value" role="status">Checking invitation…</p>
    <template v-else-if="preview.data.value">
      <h2>{{ preview.data.value.name }}</h2><p>Join this community to see its channels and chat with its members.</p>
      <UAlert v-if="auth.isError.value" color="error" title="Could not check your sign-in" />
      <UButton v-if="auth.isError.value" color="neutral" variant="outline" @click="auth.refetch()">Try again</UButton>
      <p v-else-if="auth.isPending.value" role="status">Opening your account…</p>
      <template v-else-if="auth.data.value?.user"><p>Signed in as <strong>{{ auth.data.value.user.name }}</strong> on {{ host }}.</p><UButton :loading="busy" block @click="join">Join as {{ auth.data.value.user.name }}</UButton></template>
      <div v-else class="space-y-3"><UAlert v-if="auth.telegramError.value" color="error" :title="auth.telegramError.value" /><UButton block @click="login(false)">Log in to join</UButton><UButton v-if="auth.data.value?.methods?.registration" color="neutral" variant="outline" block @click="login(true)">Create an account</UButton></div>
    </template>
    <UAlert v-if="error" color="error" :title="error" />
    <p class="invitation-scope">Accounts and memberships belong to each installation. To keep an existing account’s history, link Telegram from that account’s User Settings before joining.</p>
    <div class="flex flex-wrap gap-3"><UButton v-if="token" color="neutral" variant="outline" :disabled="busy" @click="change">Use another invitation</UButton><UButton color="neutral" variant="ghost" :disabled="busy" @click="cancel">Back to servers</UButton></div>
  </div>
</template>

<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { inviteInputSchema } from '../../shared/contracts'
import { apiFor } from '../utils/api'
import { getApiTarget } from '../utils/connection'
const props = defineProps<{ workspaceId: string }>()
const target = getApiTarget(), api = apiFor(target), state = reactive({ expiresInHours: 168, maxUses: 25 })
const invites = useQuery({ queryKey: ['invites', props.workspaceId], queryFn: () => api('invites', { params: { workspaceId: props.workspaceId } }) })
const link = ref(''), error = ref(''), busy = ref(false), copied = ref(false)
async function create() {
  busy.value = true; error.value = ''; copied.value = false
  try {
    const result = await api('inviteCreate', { params: { workspaceId: props.workspaceId }, body: state })
    link.value = `${target.origin || location.origin}/invite#token=${result.token}`
    await invites.refetch()
  } catch (cause) { error.value = apiError(cause) } finally { busy.value = false }
}
async function revoke(id: string) {
  busy.value = true; error.value = ''
  try { await api('inviteRevoke', { params: { workspaceId: props.workspaceId, inviteId: id } }); link.value = ''; await invites.refetch() }
  catch (cause) { error.value = apiError(cause) } finally { busy.value = false }
}
async function copy() { try { await navigator.clipboard.writeText(link.value); copied.value = true } catch { error.value = 'Could not copy. Select the link and copy it manually.' } }
</script>
<template>
  <div class="space-y-5"><h2>Invitations</h2><p class="section-description">Invite people to this server. They sign in or create an account on this installation before joining. Links grant membership, never owner permissions.</p>
    <UForm :state="state" :schema="inviteInputSchema" class="space-y-4" @submit="create"><div class="field-grid"><UFormField name="expiresInHours" label="EXPIRES AFTER (HOURS)" required><UInput v-model.number="state.expiresInHours" type="number" :min="1" :max="720" class="w-full" /></UFormField><UFormField name="maxUses" label="MAXIMUM NEW MEMBERS" required><UInput v-model.number="state.maxUses" type="number" :min="1" :max="1000" class="w-full" /></UFormField></div><UButton type="submit" icon="i-lucide-link" :loading="busy">Create invitation</UButton></UForm>
    <div v-if="link" class="space-y-3"><UFormField label="INVITATION LINK" description="Copy this now. Saved invitations do not expose their secret links."><UInput :model-value="link" readonly aria-label="Invitation link" class="w-full" /></UFormField><UButton color="neutral" variant="outline" @click="copy">{{ copied ? 'Copied' : 'Copy link' }}</UButton></div>
    <UAlert v-if="error || invites.isError.value" color="error" :title="error || apiError(invites.error.value)" />
    <h3>Created invitations</h3><p v-if="!invites.data.value?.length" class="text-muted">No invitations yet.</p>
    <div v-for="invite in invites.data.value" :key="invite.id" class="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-elevated p-3"><span>{{ invite.uses }} / {{ invite.maxUses }} joined<small class="block text-muted">{{ invite.expiresAt <= Date.now() ? 'Expired' : invite.uses >= invite.maxUses ? 'Limit reached' : 'Expires' }} · {{ new Date(invite.expiresAt).toLocaleString() }}</small></span><UButton color="error" variant="ghost" :disabled="busy" @click="revoke(invite.id)">Revoke</UButton></div>
  </div>
</template>

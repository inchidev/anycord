<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { telegramIntegrationInputSchema } from '../../shared/contracts'
const api = apiFor(), client = useQueryClient()
const config = useQuery({ queryKey: ['telegram-integration'], queryFn: () => api('telegramIntegration') })
const state = reactive({ botToken: '', clientId: '', clientSecret: '', notifications: false })
const error = ref(''), feedback = ref('')
watch(config.data, data => { if (data) { state.clientId = data.clientId; state.notifications = data.notifications } }, { immediate: true })
const save = useMutation({ mutationFn: (remove: boolean) => api('telegramIntegrationUpdate', { body: { ...state, botToken: remove ? '' : state.botToken || undefined, clientSecret: state.clientSecret || undefined } }),
  onSuccess: async () => { state.botToken = ''; state.clientSecret = ''; feedback.value = 'Telegram settings saved. Secrets are encrypted on the server.'; await Promise.all([client.invalidateQueries({ queryKey: ['telegram-integration'] }), client.invalidateQueries({ queryKey: ['authentication'] }), client.invalidateQueries({ queryKey: ['telegram-account'] })]) },
  onError: cause => { error.value = apiError(cause) },
})
const webhook = useMutation({ mutationFn: () => api('telegramWebhookSetup'), onSuccess: () => { feedback.value = 'Telegram webhook connected. Members can now start the bot to enable delivery.' }, onError: cause => { error.value = apiError(cause) } })
</script>
<template>
  <div class="integration-heading"><UIcon name="i-lucide-send" /><h3>Telegram</h3><span :class="['connection-label', { configured: config.data.value?.botConfigured }]">{{ config.data.value?.botConfigured ? `@${config.data.value.botUsername}` : 'Not configured' }}</span></div>
  <p>Connect one bot for this installation’s Telegram login, Mini App and personal notifications. Enable login methods in Authentication.</p>
  <UAlert v-if="config.isError.value" color="error" title="Could not load Telegram settings" />
  <UForm v-if="config.data.value" :schema="telegramIntegrationInputSchema" :state="state" class="integration-form" @submit="error = ''; feedback = ''; save.mutate(false)">
    <UFormField name="botToken" label="BOT TOKEN" description="From BotFather. Leave blank to keep the saved token; saving a new token verifies the bot."><UInput v-model="state.botToken" type="password" autocomplete="new-password" class="w-full" :placeholder="config.data.value.botConfigured ? 'Saved token — enter a replacement' : 'Paste your bot token'" /></UFormField>
    <UFormField name="clientId" label="OIDC CLIENT ID"><UInput v-model="state.clientId" inputmode="numeric" class="w-full" /></UFormField>
    <UFormField name="clientSecret" label="OIDC CLIENT SECRET" description="BotFather Web Login gives you a separate secret. This is different from the bot token. Leave blank to keep the saved secret."><UInput v-model="state.clientSecret" type="password" autocomplete="new-password" class="w-full" /></UFormField>
    <UFormField name="notifications" label="Telegram notifications" description="Allow members to opt in. Login works without enabling notifications."><USwitch v-model="state.notifications" /></UFormField>
    <UAlert v-if="error" color="error" :title="error" /><UAlert v-if="feedback" color="success" :title="feedback" />
    <div class="integration-actions flex-wrap"><UButton type="submit" :loading="save.isPending.value">Save Telegram</UButton><UButton color="neutral" variant="outline" :disabled="!config.data.value.botConfigured || save.isPending.value" :loading="webhook.isPending.value" @click="error = ''; feedback = ''; webhook.mutate()">Connect notification webhook</UButton><UButton v-if="config.data.value.botConfigured" color="error" variant="ghost" :disabled="save.isPending.value" @click="error = ''; feedback = ''; save.mutate(true)">Remove bot</UButton></div>
    <details class="telegram-guide"><summary>Setup instructions</summary><ol>
      <li>Open <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">BotFather</a>, create or select a bot, and paste its token above.</li>
      <li>Open the bot’s Web Login / Login Widget settings. Enable OIDC and copy the Client ID and separate Client Secret.</li>
      <li>Register this website origin and exact callback URL as Allowed URLs:<UInput :model-value="config.data.value.origin" readonly aria-label="Allowed origin" class="w-full" /><UInput :model-value="config.data.value.callbackURL" readonly aria-label="OIDC callback URL" class="w-full" /></li>
      <li>Set the bot’s Main Mini App or menu-button Web App URL:<UInput :model-value="config.data.value.miniAppURL" readonly aria-label="Mini App URL" class="w-full" /></li>
      <li>Save Telegram, then enable browser and/or Mini App login in Authentication. Test in a separate browser session.</li>
      <li>For notifications, enable the switch, save, and connect the notification webhook. Members link Telegram in User Settings, start this bot and opt in. Connecting a webhook replaces any existing webhook on this bot; use a dedicated Anycord bot.</li>
    </ol><p>Use a public HTTPS origin. For local testing, use a dedicated test bot and HTTPS tunnel. <a href="https://core.telegram.org/bots/telegram-login" target="_blank" rel="noopener noreferrer">Telegram login documentation</a></p></details>
  </UForm>
</template>

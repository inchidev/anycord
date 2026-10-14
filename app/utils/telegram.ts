import { getApiTarget } from './connection'
import { safeNext } from '../../shared/navigation'

declare global { interface Window { Telegram?: { WebApp?: { initData?: string; ready?: () => void } } } }
export function telegramInitData() {
  return window.Telegram?.WebApp?.initData || useNuxtApp().$telegramLaunchData || ''
}
export async function miniAppSignIn(link = false) {
  if (getApiTarget().origin) throw new Error('Open this installation directly in Telegram to link your account.')
  const initData = telegramInitData()
  if (!initData) throw new Error('Open this installation’s Mini App in Telegram first.')
  await $fetch('/api/auth/telegram/miniapp', { method: 'POST', body: { initData, link } })
}
export async function telegramSignIn(link = false, next: unknown = '/servers') {
  if (getApiTarget().origin) throw new Error('Open this installation directly to sign in with Telegram.')
  const result = await $fetch<{ url: string }>(link ? '/api/auth/link-social' : '/api/auth/sign-in/social', {
    method: 'POST', body: { provider: 'telegram', callbackURL: safeNext(next) },
  })
  const url = new URL(result.url)
  if (url.origin !== 'https://oauth.telegram.org') throw new Error('Unexpected Telegram login destination')
  location.assign(url.href)
}

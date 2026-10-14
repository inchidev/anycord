export default defineNuxtPlugin({
  name: 'telegram-launch',
  // Nuxt's router runs at pre (-20). Its hash normalization decodes the
  // nested query separators in tgWebAppData, so capture it before that plugin.
  order: -30,
  setup() {
    const params = new URLSearchParams(window.location.hash.slice(1))
    const initData = window.Telegram?.WebApp?.initData || params.get('tgWebAppData') || ''
    if (params.has('tgWebAppData')) {
      // Keep signed launch data in this app instance only, never in route.next,
      // history URLs, localStorage or sessionStorage.
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
    }
    return { provide: { telegramLaunchData: initData } }
  },
})

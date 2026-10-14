import type { MiniAppSession } from '../utils/telegram'
export default defineNuxtPlugin({
  name: 'telegram-launch',
  // Nuxt's router runs at pre (-20). Its hash normalization decodes the
  // nested query separators in tgWebAppData, so capture it before that plugin.
  order: -30,
  async setup() {
    const params = new URLSearchParams(window.location.hash.slice(1))
    const initData = window.Telegram?.WebApp?.initData || params.get('tgWebAppData') || ''
    // Reloads (including a PWA update) have no signed fragment. Remember only
    // the UI context so those pages still receive Telegram's live safe areas.
    let miniApp = !!initData || !!window.Telegram?.WebApp || !!window.TelegramWebviewProxy
    try { miniApp ||= sessionStorage.getItem('anycord-telegram-ui') === '1' } catch {}
    if (window.parent !== window && document.referrer.startsWith('https://web.telegram.org/')) miniApp = true
    if (miniApp) {
      document.documentElement.dataset.telegram = ''
      try { sessionStorage.setItem('anycord-telegram-ui', '1') } catch {}
      // The official SDK persists its launch parameters. Give it only UI
      // metadata: signed identity stays in this app instance, never storage.
      const uiParams = new URLSearchParams()
      for (const key of ['tgWebAppVersion', 'tgWebAppPlatform', 'tgWebAppThemeParams', 'tgWebAppFullscreen']) {
        const value = params.get(key)
        if (value) uiParams.set(key, value)
      }
      if (initData) {
        const path = ['/', '/main'].includes(location.pathname) || (location.pathname === '/login' && !location.search) ? '/servers' : location.pathname
        window.history.replaceState(window.history.state, '', path + location.search + (uiParams.size ? '#' + uiParams : ''))
      }
      if (!window.Telegram?.WebApp) {
        // Discard legacy SDK identity persistence before it merges stored params.
        try {
          const stored = JSON.parse(sessionStorage.getItem('__telegram__initParams') || '{}')
          if (stored?.tgWebAppData) sessionStorage.removeItem('__telegram__initParams')
        } catch {}
        const script = document.createElement('script')
        script.src = 'https://telegram.org/js/telegram-web-app.js'
        const loaded = new Promise<void>(resolve => {
          script.onload = () => resolve()
          script.onerror = () => resolve()
        })
        document.head.appendChild(script)
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([loaded, new Promise<void>(resolve => { timer = setTimeout(resolve, 2000) })])
        clearTimeout(timer)
        void loaded.then(() => window.Telegram?.WebApp?.ready?.())
      }
      else window.Telegram.WebApp.ready?.()
    }
    if (initData || params.has('tgWebAppData')) {
      // Keep signed launch data in this app instance only, never in route.next,
      // history URLs, localStorage or sessionStorage.
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
    }
    return { provide: { telegramLaunchData: initData, telegramSession: {} as MiniAppSession } }
  },
})

export default defineNuxtPlugin({
  name: 'telegram-colors', dependsOn: ['telegram-launch'],
  setup(nuxtApp) {
    const root = document.documentElement
    if (!root.hasAttribute('data-telegram')) return
    let frame = 0, previous = '', previousSDK: NonNullable<Window['Telegram']>['WebApp']
    function paint() {
      frame = 0
      // Prefer the topmost visible header; desktop chat also has a title bar.
      let node: Element | null = ['.settings-fullscreen .settings-navigation', '.desktop-titlebar', '.chat-header', '.picker-nav', '.auth-screen', '.boot-screen']
        .map(selector => document.querySelector(selector)).find(element => element && element.getClientRects().length) || document.body
      let color = ''
      while (node) {
        const background = getComputedStyle(node).backgroundColor
        if (background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)') { color = background; break }
        node = node.parentElement
      }
      const rgb = color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/)
      if (!rgb) return
      const hex = '#' + rgb.slice(1).map(value => Number(value).toString(16).padStart(2, '0')).join('')
      const sdk = window.Telegram?.WebApp
      if (previous === hex && previousSDK === sdk) return
      previous = hex; previousSDK = sdk
      root.style.setProperty('--telegram-header-color', hex)
      // Old clients may reject custom header colours; layout must still work.
      try { sdk?.setHeaderColor?.(hex); sdk?.setBackgroundColor?.(hex) } catch {}
    }
    function schedule() { if (!frame) frame = requestAnimationFrame(paint) }
    nuxtApp.hook('app:mounted', () => {
      paint()
      new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true })
    })
    nuxtApp.hook('page:finish', schedule)
    window.addEventListener('resize', schedule)
    document.querySelector('script[src="https://telegram.org/js/telegram-web-app.js"]')?.addEventListener('load', schedule)
  },
})

export default defineNuxtConfig({
  compatibilityDate: '2026-10-14',
  ssr: false,
  experimental: { emitRouteChunkError: 'manual' },
  devtools: { enabled: false },
  modules: ['@nuxt/ui', '@vueuse/nuxt'],
  css: ['~/assets/css/main.css'],
  ui: { fonts: false },
  colorMode: { preference: 'dark', fallback: 'dark' },
  icon: { clientBundle: { scan: true, sizeLimitKb: 512 } },
  app: {
    head: {
      title: 'Anycord · Chat on your terms',
      htmlAttrs: { lang: 'en' },
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content' }, { name: 'theme-color', content: '#1e1f22' }, { name: 'description', content: 'Chat, share files and connect to independent communities. Your people, your choice of server.' }],
      link: [{ rel: 'icon', href: '/favicon.png', type: 'image/png' }, { rel: 'manifest', href: '/manifest.webmanifest' }, { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' }],
    },
  },
  nitro: { preset: 'static', prerender: { routes: ['/', '/login', '/servers'] } },
  typescript: { strict: true },
  vue: { compilerOptions: { isCustomElement: (tag) => tag.startsWith('rtk-') } },
})

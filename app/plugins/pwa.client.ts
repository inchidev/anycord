import { computed, ref } from 'vue'
type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }
export default defineNuxtPlugin((nuxtApp) => {
  const online = ref(navigator.onLine), waiting = ref(false), updating = ref(false), error = ref('')
  const installed = ref(matchMedia('(display-mode: standalone)').matches || !!(navigator as Navigator & { standalone?: boolean }).standalone)
  const installPrompt = ref<InstallPrompt | null>(null)
  const help = ref(false)
  const pendingSends = useState<Record<string, boolean>>('anycord-pending-sends', () => ({}))
  let registration: ServiceWorkerRegistration | undefined
  let reloadOnChange = false
  function network() { online.value = navigator.onLine }
  window.addEventListener('online', network); window.addEventListener('offline', network)
  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt.value = event as InstallPrompt })
  window.addEventListener('appinstalled', () => { installed.value = true; installPrompt.value = null })
  async function install() {
    if (!installPrompt.value) { help.value = true; return }
    const prompt = installPrompt.value; installPrompt.value = null
    await prompt.prompt()
    if ((await prompt.userChoice).outcome === 'accepted') installed.value = true
  }
  async function update() {
    if (!registration?.waiting || updating.value) return
    if (Object.values(pendingSends.value).some(Boolean) || document.querySelector('[data-uploading="true"]')) {
      error.value = 'Finish sending messages and uploading files before updating.'
      return
    }
    // Do not throw away in-memory drafts when browser storage is unavailable.
    if (!nuxtApp.$persistDrafts()) {
      error.value = 'Your browser could not save drafts. Copy your draft text before reloading.'
      return
    }
    error.value = ''; updating.value = true; reloadOnChange = true
    registration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' })
  }
  if ('serviceWorker' in navigator && !import.meta.dev) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadOnChange) { reloadOnChange = false; location.reload() }
      else if (registration) waiting.value = !!registration.waiting
    })
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((value) => {
      registration = value
      waiting.value = !!value.waiting
      value.addEventListener('updatefound', () => {
        const worker = value.installing
        worker?.addEventListener('statechange', () => {
          waiting.value = !!value.waiting
          if (worker.state === 'redundant') error.value = 'Offline setup could not finish. Reconnect and reopen Anycord to try again.'
        })
      })
      const check = () => { if (navigator.onLine) void value.update().catch(() => {}) }
      window.addEventListener('online', check)
      document.addEventListener('visibilitychange', () => { if (!document.hidden) check() })
    }).catch(() => { error.value = 'Offline setup is unavailable. You can continue using Anycord online.' })
  }
  // Stale chunks must never trigger an automatic reload that loses a draft.
  nuxtApp.hook('app:chunkError', () => { error.value = 'Some app files are unavailable. Reconnect, then check for an update.'; void registration?.update().catch(() => {}) })
  return { provide: { pwa: { online, waiting, updating, error, installed, help, canInstall: computed(() => !installed.value), install, update } } }
})

import { reactive, ref, computed, watch } from 'vue'
import { connectionOrigin, setApiTarget } from '../utils/connection'
type ConnectionView = 'manage' | 'choose' | 'create' | 'remote'
type Connection = { id: string; origin: string; name: string }
export default defineNuxtPlugin(() => {
  const entries = reactive<Connection[]>([]), active = ref('local'), revision = ref(0), open = ref(false)
  const view = ref<ConnectionView>('manage'), localName = ref('')
  const nativeName = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? 'This device' : location.hostname
  const tokens = new Map<string, string>()
  try {
    localName.value = localStorage.getItem('anycord-local-name')?.slice(0, 50) || ''
    const saved: unknown = JSON.parse(localStorage.getItem('anycord-connections') || '[]')
    if (Array.isArray(saved)) for (const item of saved.slice(0, 32)) {
      if (!item || typeof item.origin !== 'string') continue
      try { const origin = connectionOrigin(item.origin); if (origin === location.origin || entries.some(e => e.origin === origin)) continue
        entries.push({ id: origin, origin, name: typeof item.name === 'string' ? item.name.slice(0, 50) : new URL(origin).host })
        const token = sessionStorage.getItem(`anycord-session:${origin}`); if (token) tokens.set(origin, token)
      } catch {}
    }
    const previous = localStorage.getItem('anycord-active-connection')
    if (previous && entries.some(e => e.id === previous)) active.value = previous
  } catch {}
  const current = computed(() => entries.find(e => e.id === active.value))
  const label = computed(() => current.value?.name || localName.value || nativeName)
  function show(next: ConnectionView = 'manage') { view.value = next; open.value = true }
  function rename(id: string, name: string) {
    const value = name.trim().slice(0, 50)
    if (id === 'local') { localName.value = value; try { localStorage.setItem('anycord-local-name', value) } catch {} }
    else { const entry = entries.find(e => e.id === id); if (entry) entry.name = value || new URL(entry.origin).host }
  }
  function apply() { setApiTarget({ origin: current.value?.origin || '', token: tokens.get(active.value) || '' }) }
  apply()
  function select(id: string) {
    if (id !== 'local' && !entries.some(e => e.id === id)) return
    active.value = id; apply(); revision.value++
    try { localStorage.setItem('anycord-active-connection', id) } catch {}
  }
  function add(address: string, name = '') {
    const origin = connectionOrigin(address)
    if (origin === location.origin) { if (name.trim()) rename('local', name); select('local'); return }
    if (!entries.some(e => e.id === origin)) entries.push({ id: origin, origin, name: name.trim().slice(0, 50) || new URL(origin).host })
    else if (name.trim()) rename(origin, name)
    select(origin)
  }
  function authenticate(token: string) {
    if (active.value === 'local') return
    tokens.set(active.value, token)
    try { sessionStorage.setItem(`anycord-session:${active.value}`, token) } catch {}
    apply(); revision.value++
  }
  function forgetToken() {
    tokens.delete(active.value)
    try { sessionStorage.removeItem(`anycord-session:${active.value}`) } catch {}
    apply(); revision.value++
  }
  function remove(id: string) {
    const i = entries.findIndex(e => e.id === id); if (i >= 0) entries.splice(i, 1)
    tokens.delete(id); try { sessionStorage.removeItem(`anycord-session:${id}`) } catch {}
    if (active.value === id) select('local')
  }
  watch(entries, () => { try { localStorage.setItem('anycord-connections', JSON.stringify(entries)) } catch {} }, { deep: true })
  return { provide: { connections: { entries, active, current, revision, open, view, label, localName, nativeName, show, rename, select, add, authenticate, forgetToken, remove } } }
})

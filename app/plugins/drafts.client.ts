import { effectScope, reactive, watch } from 'vue'
import { draftStateSchema, draftStoreKey, type DraftState } from '../../shared/drafts'

// One store and persistence watcher per account for the whole app, including unmounted composers.
export default defineNuxtPlugin(() => {
  const stores = new Map<string, Record<string, DraftState>>()
  const stops = new Map<string, () => void>()
  function persistDrafts() {
    try { for (const [key, store] of stores) localStorage.setItem(key, JSON.stringify(store)); return true } catch { return false }
  }
  function clearDrafts(userId?: string, scope = '') {
    const prefix = userId ? draftStoreKey(userId, scope) : `anycord-message-drafts:${scope ? encodeURIComponent(scope) + ':' : ''}`
    for (const key of stores.keys()) if (userId ? key === prefix : key.startsWith(prefix)) { stops.get(key)?.(); stops.delete(key); stores.delete(key) }
    try {
      if (userId) localStorage.removeItem(prefix)
      else for (const key of Object.keys(localStorage)) if (scope && key.startsWith(prefix)) localStorage.removeItem(key)
    } catch { /* Storage may be unavailable. In-memory data is still discarded. */ }
  }
  function draftStore(userId: string, scope = '') {
    const key = draftStoreKey(userId, scope), existing = stores.get(key)
    if (existing) return existing
    const initial: Record<string, DraftState> = {}
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(key) || '{}')
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [context, value] of Object.entries(raw)) {
        const parsed = draftStateSchema.safeParse(value)
        if (parsed.success) initial[context] = parsed.data
      }
    } catch { /* Storage may be unavailable; the in-memory draft still works. */ }
    const store = reactive(initial)
    stores.set(key, store)
    const scopeEffect = effectScope(true)
    scopeEffect.run(() => watch(store, () => { try { localStorage.setItem(key, JSON.stringify(store)) } catch { /* Keep draft in this tab. */ } }, { deep: true, flush: 'sync' }))
    stops.set(key, () => scopeEffect.stop())
    return store
  }
  return { provide: { draftStore, persistDrafts, clearDrafts } }
})

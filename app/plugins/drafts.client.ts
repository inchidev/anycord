import { effectScope, reactive, watch } from 'vue'
import { draftStateSchema, draftStoreKey, type DraftState } from '../../shared/drafts'

// One store and persistence watcher per account for the whole app, including unmounted composers.
export default defineNuxtPlugin(() => {
  const stores = new Map<string, Record<string, DraftState>>()
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
    effectScope(true).run(() => watch(store, () => { try { localStorage.setItem(key, JSON.stringify(store)) } catch { /* Keep draft in this tab. */ } }, { deep: true, flush: 'sync' }))
    return store
  }
  return { provide: { draftStore } }
})

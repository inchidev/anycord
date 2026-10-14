import { useQuery } from '@tanstack/vue-query'
import { apiFor } from '../utils/api'
import { getApiTarget } from '../utils/connection'
import { telegramInitData } from '../utils/telegram'

// Resolve Mini App sign-in inside the session check, before any login UI can
// render. Share the attempt across routes and query-client/connection remounts.
export function useAuthSession(enabled = computed(() => true)) {
  const target = getApiTarget(), api = apiFor(target), { $telegramSession: session } = useNuxtApp()
  const initData = telegramInitData()
  const error = useState('telegram-login-error', () => '')
  const query = useQuery({
    queryKey: ['auth'], retry: false, enabled,
    queryFn: async () => {
      const status = await api('authStatus')
      if (status.user || !status.initialized || !status.methods?.miniAppLogin || target.origin || !initData) return status
      if (!session.attempt) {
        session.attempt = $fetch('/api/auth/telegram/miniapp', { method: 'POST', body: { initData, link: false } })
          .then(() => { session.authenticated = true })
          .catch(cause => { error.value = apiError(cause) })
      }
      await session.attempt
      return session.authenticated ? api('authStatus') : status
    },
  })
  return { ...query, telegramError: computed(() => target.origin ? '' : error.value) }
}

import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { apiFor } from '../utils/api'

// Server membership belongs to the installation, independent of the open server.
// The enclosing ConnectionWorkspace owns a separate QueryClient per connection.
export function useInstallationServers(userId: () => string | undefined) {
  const api = apiFor()
  return useQuery({
    queryKey: computed(() => ['server-picker', userId()]),
    queryFn: () => api('bootstrap'),
    select: data => data.workspaces,
    enabled: computed(() => !!userId()),
    staleTime: 0,
  })
}

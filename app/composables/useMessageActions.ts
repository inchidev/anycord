import { useQueryClient } from '@tanstack/vue-query'
import { editMessageSchema, reactionSchema, type Message } from '../../shared/contracts'
import { apiFor } from '../utils/api'
export function useMessageActions() {
  const api = apiFor()
  const queryClient = useQueryClient(), toast = useToast()
  return async (message: Message, method: 'PATCH' | 'DELETE' | 'POST', body?: Record<string, string>) => {
    try {
      const params = { channelId: message.channelId, messageId: message.id }
      if (method === 'PATCH') await api('messageEdit', { params, body: editMessageSchema.parse(body) })
      else if (method === 'POST') await api('reactionToggle', { params, body: reactionSchema.parse(body) })
      else await api('messageDelete', { params })
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['messages', message.channelId] }), queryClient.invalidateQueries({ queryKey: ['thread', message.channelId] }), queryClient.invalidateQueries({ queryKey: ['threads', message.channelId] })])
      return true
    } catch (cause) { toast.add({ title: apiError(cause), color: 'error' }); return false }
  }
}

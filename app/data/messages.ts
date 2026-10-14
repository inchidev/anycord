import { createCollection } from '@tanstack/db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import type { QueryClient } from '@tanstack/vue-query'
import type { EndpointOutput } from '../../shared/api'
import { messageResultSchema, type Message } from '../../shared/contracts'
import { apiFor } from '../utils/api'

export type ThreadResponse = EndpointOutput<'thread'>
export type MessageResponse = Message[] | ThreadResponse
export interface ConversationScope {
  userId?: string
  workspaceId: string
  channelId: string
  threadId?: string
  focus?: string
  enabled?: boolean
}
export interface MessageQueryOptions<T> {
  queryKey: readonly unknown[]
  queryFn: () => Promise<T>
  enabled: boolean
}

// Scope is captured by value: a request finishing after navigation belongs to its old key.
export function channelMessageOptions(scope: ConversationScope): MessageQueryOptions<Message[]> {
  const api = apiFor()
  const { userId, workspaceId, channelId, focus } = scope
  return {
    queryKey: ['messages', channelId, focus, userId, workspaceId],
    enabled: !!userId && !!channelId && scope.enabled !== false,
    queryFn: () => {
      if (!userId || !channelId) throw new Error('Choose an authenticated conversation first')
      return api('messages', { params: { channelId }, query: { focus } })
    },
  }
}
export function threadMessageOptions(scope: ConversationScope): MessageQueryOptions<ThreadResponse> {
  const api = apiFor()
  const { userId, workspaceId, channelId, threadId, focus } = scope
  return {
    queryKey: ['thread', channelId, threadId, focus, userId, workspaceId],
    enabled: !!userId && !!channelId && !!threadId && scope.enabled !== false,
    queryFn: () => {
      if (!userId || !channelId || !threadId) throw new Error('Choose an authenticated thread first')
      return api('thread', { params: { channelId, threadId }, query: { focus } })
    },
  }
}

export function createMessageCollection(queryClient: QueryClient, options: MessageQueryOptions<MessageResponse>) {
  return createCollection(queryCollectionOptions<typeof messageResultSchema, () => Promise<MessageResponse>>({
    ...options, queryClient, select: (data) => Array.isArray(data) ? data : data.messages, schema: messageResultSchema,
    getKey: (message) => message.id,
    refetchInterval: 30_000,
  }))
}

function appendMessage(rows: Message[], message: Message) {
  // Duplicate events must not replace a newer snapshot (including viewer-specific reactions).
  if (rows.some((row) => row.id === message.id)) return rows
  return [...rows, message].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(-100)
}

// Query remains the response authority; Query Collections project these cache changes into live rows.
// Never invent a cache entry for an unloaded conversation or update another account/workspace.
export async function receiveMessage(queryClient: QueryClient, scope: Pick<ConversationScope, 'userId' | 'workspaceId'>, message: Message) {
  if (!scope.userId) return
  const accountIndex = message.threadId ? 4 : 3
  const queryKey = message.threadId ? ['thread', message.channelId, message.threadId] : ['messages', message.channelId]
  for (const query of queryClient.getQueryCache().findAll({ queryKey })) {
    const key = query.queryKey
    // Focused history windows retain their server-selected neighborhood.
    if (key[accountIndex - 1] || key[accountIndex] !== scope.userId || key[accountIndex + 1] !== scope.workspaceId) continue
    if (query.state.data === undefined) {
      // An initial snapshot can predate this event. Reload after it settles, without
      // fabricating a partial snapshot or canceling the only initial request.
      void query.promise?.then(() => queryClient.invalidateQueries({ queryKey: key, exact: true }), () => {})
      continue
    }
    // A response already in flight must not overwrite a more recent live message.
    if (query.state.fetchStatus === 'fetching') await queryClient.cancelQueries({ queryKey: key, exact: true })
    if (queryClient.getQueryCache().find({ queryKey: key, exact: true }) !== query) continue
    if (!message.threadId) queryClient.setQueryData<Message[]>(key, (rows) => rows && appendMessage(rows, message))
    else queryClient.setQueryData<ThreadResponse>(key, (data) => {
      if (!data) return data
      const messages = appendMessage(data.messages, message)
      // Keep the server's count: a bounded window cannot prove whether an unseen
      // event is already included in that count. Summaries refetch independently.
      return messages === data.messages ? data : { ...data, messages }
    })
  }
}

import { computed, onScopeDispose, watch, type ComputedRef } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { useLiveQuery } from '@tanstack/vue-db'
import { channelMessageOptions, createMessageCollection, threadMessageOptions, type ConversationScope, type MessageQueryOptions, type MessageResponse } from '../data/messages'

function useMessageCollection<T extends MessageResponse>(options: ComputedRef<MessageQueryOptions<T>>) {
  // Both observers share one Query key/request/cache. Query supplies its familiar loading,
  // errors, retry and response envelope; DB supplies the reactive, ordered message rows.
  const query = useQuery(options)
  const queryClient = useQueryClient()
  const collection = computed(() => createMessageCollection(queryClient, options.value))
  const live = useLiveQuery((q) => options.value.enabled
    ? q.from({ message: collection.value }).orderBy(({ message }) => message.createdAt, 'asc').orderBy(({ message }) => message.id, 'asc')
    : undefined)
  // Dispose the derived query before its source, including on navigation/logout.
  watch([live.collection, collection], (_next, [previousLive, previousSource]) => {
    void (async () => { await previousLive?.cleanup(); await previousSource.cleanup() })()
  }, { flush: 'post' })
  onScopeDispose(() => {
    const source = collection.value, derived = live.collection.value
    void (async () => { await derived?.cleanup(); await source.cleanup() })()
  })
  return { query, messages: live.data }
}

export function useChannelMessages(scope: () => ConversationScope) {
  return useMessageCollection(computed(() => channelMessageOptions(scope())))
}
export function useThreadMessages(scope: () => ConversationScope) {
  return useMessageCollection(computed(() => threadMessageOptions(scope())))
}

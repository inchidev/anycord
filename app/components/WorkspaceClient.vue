<script setup lang="ts">
const location = window.location
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { useDebounceFn, useEventListener, useLocalStorage, useMediaQuery, useOnline, useWebSocket, useWindowSize } from '@vueuse/core'
import { AUTH_SESSION_CLOSE_CODE, channelSchema, liveEventSchema, type Channel, type Message } from '../../shared/contracts'
import { apiFor } from '../utils/api'
import { serverPath } from '../../shared/navigation'
import { livePath } from '../../shared/api'
import { getApiTarget } from '../utils/connection'
import { receiveMessage } from '../data/messages'
import { installMobileViewport, type ChatViewport } from '../utils/mobile-viewport'

const api = apiFor()
const { $connections: connections } = useNuxtApp()
const target = getApiTarget()
const route = useRoute(), router = useRouter(), toast = useToast(), queryClient = useQueryClient()
const auth = useQuery({ queryKey: ['auth'], queryFn: () => api('authStatus'), retry: false })
const user = computed(() => auth.data.value?.user)
const serverList = useInstallationServers(() => user.value?.id)
const installationOrigin = computed(() => target.origin || location.origin)
const installationHost = computed(() => new URL(installationOrigin.value).host)
watch(() => auth.data.value, data => { if (data && !data.user) void router.replace({ path: '/login', query: { next: route.fullPath } }) }, { immediate: true })
const workspaceId = computed(() => typeof route.params.serverId === 'string' ? route.params.serverId : 'main')
const bootstrap = useQuery({ queryKey: computed(() => ['bootstrap', user.value?.id, workspaceId.value]), queryFn: () => api('bootstrap', { query: { workspace: workspaceId.value } }), enabled: computed(() => !!user.value) })
const channels = computed(() => bootstrap.data.value?.channels || [])
const workspace = computed(() => bootstrap.data.value?.workspaces.find((item) => item.id === workspaceId.value) || serverList.data.value?.find((item) => item.id === workspaceId.value))
const channel = computed(() => channels.value.find((item) => item.id === route.params.channelId) || channels.value.find((item) => item.kind === 'text') || channels.value[0])
const channelId = computed(() => channel.value?.id || '')
const threadId = computed(() => typeof route.query.thread === 'string' ? route.query.thread : undefined)
const focusedId = computed(() => route.hash.startsWith('#message-') ? route.hash.slice(9) : undefined)
const focusMessageId = computed(() => threadId.value ? undefined : focusedId.value)
const narrowThread = useMediaQuery('(max-width: 1300px)')
const threadPanelActive = computed(() => (!!threadId.value || !!threadTarget.value) && channel.value?.kind === 'text' && !bootstrap.isError.value)
const threadModalActive = computed(() => threadPanelActive.value && narrowThread.value)
const threadsOpen = ref(false)
const threadTarget = ref<Message | null>(null)

const replyTo = ref<Message | null>(null)
const composer = useTemplateRef('composer')
const composerLayout = ref({ bottom: 24, height: 48 })
const threadsQuery = useQuery({ queryKey: computed(() => ['threads', channelId.value]), queryFn: () => api('threads', { params: { channelId: channelId.value } }), enabled: computed(() => threadsOpen.value && !!channelId.value) })
const { query: messagesQuery, messages } = useChannelMessages(() => ({ userId: user.value?.id, workspaceId: workspaceId.value, channelId: channelId.value, focus: focusMessageId.value, enabled: channel.value?.kind === 'text' }))
const online = useOnline()
const membersVisible = useLocalStorage('cellcord-members-visible', true)
const textChannelsOpen = ref(true), voiceChannelsOpen = ref(true)
const sidebarOpen = ref(false), settingsOpen = ref(false), searchOpen = ref(false), createOpen = ref(false)
const memberDrawerOpen = ref(false)
const narrowScreen = useMediaQuery('(max-width: 1000px)')
const profileOpen = ref(false)
const onlineIds = ref<string[]>([])
const unread = reactive<Record<string, number>>({})
const typing = ref(''), threadTyping = ref('')
const clearTyping = useDebounceFn(() => { typing.value = ''; threadTyping.value = '' }, 3000)
const isMobile = useMediaQuery('(max-width: 700px)')
const sidebar = useTemplateRef<HTMLElement>('sidebar')
const navigation = useTemplateRef<HTMLElement>('navigation')
const viewport = shallowRef<ChatViewport>({ top: 0, keyboard: false })
let stopViewport: (() => void) | undefined
onMounted(() => { stopViewport = installMobileViewport(window, document, value => { viewport.value = value }) })
onBeforeUnmount(() => stopViewport?.())
const liveMessageIds = new Set<string>()
let lastFocusedMessage: string | undefined
const timeline = useTemplateRef<HTMLElement>('timeline')
const searchInput = useTemplateRef<HTMLElement>('searchInput')
const search = ref('')
const { width: viewportWidth } = useWindowSize()
const savedSidebarWidth = useLocalStorage('anycord-sidebar-width', 240)
const sidebarMax = computed(() => Math.max(200, Math.min(420, viewportWidth.value - 72 - 320)))
const sidebarWidth = computed(() => isMobile.value ? 240 : Math.max(200, Math.min(sidebarMax.value, Number(savedSidebarWidth.value) || 240)))
let resizeStart: { x: number; width: number; pointer: number; target: HTMLElement } | null = null
function resizeSidebar(event: PointerEvent) {
  if (event.button !== 0) return
  event.preventDefault()
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  resizeStart = { x: event.clientX, width: sidebarWidth.value, pointer: event.pointerId, target }
}
useEventListener('pointermove', (event: PointerEvent) => {
  if (resizeStart && event.pointerId === resizeStart.pointer) savedSidebarWidth.value = Math.max(200, Math.min(sidebarMax.value, resizeStart.width + event.clientX - resizeStart.x))
})
function stopResize() { if (resizeStart?.target.hasPointerCapture(resizeStart.pointer)) resizeStart.target.releasePointerCapture(resizeStart.pointer); resizeStart = null }
useEventListener('pointerup', stopResize); useEventListener('pointercancel', stopResize)
onBeforeUnmount(stopResize)
function resizeKey(event: KeyboardEvent) {
  const next = event.key === 'Home' ? 200 : event.key === 'End' ? sidebarMax.value : event.key === 'ArrowLeft' ? sidebarWidth.value - 10 : event.key === 'ArrowRight' ? sidebarWidth.value + 10 : undefined
  if (next !== undefined) { event.preventDefault(); savedSidebarWidth.value = Math.max(200, Math.min(sidebarMax.value, next)) }
}
const mobileSearchInput = useTemplateRef<HTMLElement>('mobileSearchInput')
async function focusSearch() {
  if (!isMobile.value) { searchInput.value?.querySelector('input')?.focus(); return }
  threadTarget.value = null
  if (threadId.value) await router.replace({ query: { ...route.query, thread: undefined } })
  sidebarOpen.value = false; searchOpen.value = true
  await nextTick(); mobileSearchInput.value?.querySelector('input')?.focus()
}
function closeSearch() { searchOpen.value = false; if (isMobile.value) document.querySelector<HTMLButtonElement>('.mobile-search')?.focus(); else void focusSearch() }
function submitSearch() { if (search.value.trim()) { threadTarget.value = null; void router.replace({ query: { ...route.query, thread: undefined }, hash: '' }); searchOpen.value = true } }
watch(workspaceId, () => { search.value = ''; debouncedSearch.value = ''; searchOpen.value = false })
const debouncedSearch = ref('')
const updateSearch = useDebounceFn((value: string) => { debouncedSearch.value = value }, 250)
watch(search, (value) => updateSearch(value))
const searchResults = useQuery({ queryKey: computed(() => ['search', workspaceId.value, debouncedSearch.value]), queryFn: () => api('search', { query: { workspace: workspaceId.value, q: debouncedSearch.value } }), enabled: computed(() => searchOpen.value && !!debouncedSearch.value.trim()) })
const channelState = reactive({ name: '', topic: '', kind: 'text' as 'text' | 'voice' })
const createError = ref('')
const huddle = ref<{ token: string; participantId: string; channelId: string; channel: string } | null>(null)
const huddleOpen = ref(false)
const showError = (cause: unknown) => toast.add({ title: apiError(cause), color: 'error' })

const remoteSocket = ref<string>()
let disposed = false, socketGeneration = 0, reconnectTimer: ReturnType<typeof setTimeout> | undefined
async function connectRemote() {
  const generation = ++socketGeneration
  remoteSocket.value = undefined
  if (!target.origin || !target.token || !user.value) return
  const space = workspaceId.value
  try {
    const { ticket } = await api('liveTicket', { params: { workspaceId: space } })
    if (disposed || generation !== socketGeneration || workspaceId.value !== space) return
    remoteSocket.value = `${target.origin.replace(/^http/, 'ws')}${livePath(space)}?ticket=${encodeURIComponent(ticket)}`
  } catch { if (!disposed && generation === socketGeneration) reconnectTimer = setTimeout(connectRemote, 3000) }
}
watch([user, workspaceId], () => { if (target.origin) { clearTimeout(reconnectTimer); void connectRemote() } }, { immediate: true })
onBeforeUnmount(() => { disposed = true; socketGeneration++; clearTimeout(reconnectTimer) })
const wsUrl = computed(() => target.origin ? remoteSocket.value : user.value ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${livePath(workspaceId.value)}` : undefined)
const { status: wsStatus, send: sendLive, close: closeLive } = useWebSocket(wsUrl, {
  autoReconnect: target.origin ? false : { retries: Infinity, delay: 1500 },
  onConnected: () => {
    void queryClient.invalidateQueries({ queryKey: ['messages'] })
    void queryClient.invalidateQueries({ queryKey: ['thread'] })
    void queryClient.invalidateQueries({ queryKey: ['threads'] })
  },
  onDisconnected: (_ws, event) => { if (event.code === AUTH_SESSION_CLOSE_CODE) void queryClient.invalidateQueries({ queryKey: ['auth'] }); else if (target.origin && !disposed && _ws.url === wsUrl.value) reconnectTimer = setTimeout(connectRemote, 1500) },
  onMessage: (_ws, event) => {
    if (_ws.url !== wsUrl.value) return
    let raw: unknown
    try { raw = JSON.parse(event.data) } catch { return }
    const parsed = liveEventSchema.safeParse(raw)
    if (!parsed.success) return
    const data = parsed.data
    if (data.type === 'presence') onlineIds.value = data.users
    if (data.type === 'message') {
      void receiveMessage(queryClient, { userId: user.value?.id, workspaceId: workspaceId.value }, data.message)
      // Thread summaries live in the channel's root messages as well as the thread list.
      if (data.message.threadId) void queryClient.invalidateQueries({ queryKey: ['messages', data.message.channelId] })
      void queryClient.invalidateQueries({ queryKey: ['threads', data.message.channelId] })
      if (!data.message.threadId && !liveMessageIds.has(data.message.id) && data.message.authorId !== user.value?.id && data.message.channelId !== channelId.value) unread[data.message.channelId] = (unread[data.message.channelId] || 0) + 1
      liveMessageIds.add(data.message.id)
      if (liveMessageIds.size > 500) liveMessageIds.delete(liveMessageIds.values().next().value!)
    }
    if (data.type === 'refresh') {
      void queryClient.invalidateQueries({ queryKey: ['messages', ...(data.channelId ? [data.channelId] : [])] })
      void queryClient.invalidateQueries({ queryKey: ['bootstrap'] })
      void queryClient.invalidateQueries({ queryKey: ['server-picker'] })
      void queryClient.invalidateQueries({ queryKey: ['search'] })
      void queryClient.invalidateQueries({ queryKey: ['thread'] })
      void queryClient.invalidateQueries({ queryKey: ['threads'] })
    }
    if (data.type === 'typing' && data.userId !== user.value?.id && data.channelId === channelId.value) {
      if (!data.threadId) typing.value = `${data.name} is typing`
      else if (data.threadId === threadId.value) threadTyping.value = `${data.name} is typing`
      void clearTyping()
    }
  },
})
watch(channelId, () => { threadTarget.value = null; replyTo.value = null; typing.value = ''; threadTyping.value = ''; unread[channelId.value] = 0 })
watch(threadId, () => { threadTyping.value = ''; if (threadId.value) sidebarOpen.value = false })
watch(messages, async (_messages, previous) => {
  const nearBottom = !previous?.length || !timeline.value || timeline.value.scrollHeight - timeline.value.scrollTop - timeline.value.clientHeight < 200
  await nextTick()
  if (focusMessageId.value && lastFocusedMessage !== focusMessageId.value) {
    const target = document.getElementById(`message-${focusMessageId.value}`)
    if (target) { target.scrollIntoView({ block: 'center' }); lastFocusedMessage = focusMessageId.value }
  }
  else if (!focusMessageId.value && nearBottom) timeline.value?.scrollTo({ top: timeline.value.scrollHeight, behavior: 'instant' })
})
watch(focusMessageId, () => { lastFocusedMessage = undefined })
function latestMessages() { return router.replace({ query: route.query, hash: '' }) }
function toggleMembers() { if (narrowScreen.value) memberDrawerOpen.value = !memberDrawerOpen.value; else membersVisible.value = !membersVisible.value }
watch(sidebarOpen, async (open) => {
  if (!isMobile.value) return
  await nextTick()
  if (open) sidebar.value?.querySelector<HTMLButtonElement>('button')?.focus()
  else document.querySelector<HTMLButtonElement>('.mobile-menu')?.focus()
})

async function selectChannel(item: Channel) {
  await router.push(serverPath(workspaceId.value, item.id)); sidebarOpen.value = false
}
async function selectWorkspace(id: string) {
  const browsing = isMobile.value && sidebarOpen.value
  await router.push(serverPath(id)); sidebarOpen.value = browsing; onlineIds.value = []
  textChannelsOpen.value = true; voiceChannelsOpen.value = true
}
async function authenticated() { await queryClient.invalidateQueries({ queryKey: ['auth'] }) }
async function logout() {
  try {
    if (huddle.value) await leaveHuddle()
    await api('authLogout')
    closeLive(); if (target.origin) connections.forgetToken(); else { queryClient.clear(); await auth.refetch() }; await router.replace('/login')
  } catch (cause) { showError(cause) }
}
const messageAction = useMessageActions()
function liveTyping(event: { type: 'typing'; channelId: string; threadId?: string }) { sendLive(JSON.stringify(event)) }
function reply(message: Message) { replyTo.value = message; void nextTick(() => composer.value?.focus()) }
function jumpToMessage(id: string, inThread?: string | null) {
  return router.replace({ query: { ...route.query, thread: inThread || undefined }, hash: id ? `#message-${id}` : '' })
}
let threadReturnFocus: HTMLElement | null = null
async function closeThread() {
  threadTarget.value = null
  await router.replace({ query: { ...route.query, thread: undefined }, hash: '' }); await nextTick()
  composer.value?.measure()
  if (threadReturnFocus?.isConnected) threadReturnFocus.focus()
  else document.querySelector<HTMLButtonElement>('[aria-label="Browse threads"]')?.focus()
}
function openThread(message: Message) {
  searchOpen.value = false
  threadReturnFocus = document.getElementById(`message-${message.id}`) || (document.activeElement instanceof HTMLElement ? document.activeElement : null)
  if (message.thread) { threadTarget.value = null; return router.push({ query: { ...route.query, thread: message.thread.id }, hash: '' }) }
  threadTarget.value = message
  void router.replace({ query: { ...route.query, thread: undefined }, hash: '' })
}
async function threadCreated(id: string) {
  threadTarget.value = null
  await router.push({ query: { ...route.query, thread: id }, hash: '' })
}
async function copyMessageLink(message: Message) {
  const query = new URLSearchParams()
  if (message.threadId) query.set('thread', message.threadId)
  try { await navigator.clipboard.writeText(`${target.origin || location.origin}${serverPath(workspaceId.value, message.channelId)}${query.size ? '?' + query : ''}#message-${message.id}`); toast.add({ title: 'Message link copied.' }) }
  catch { toast.add({ title: 'Could not copy the link. Check clipboard permission.', color: 'error' }) }
}
const createChannel = useMutation({
  mutationFn: () => api('channelCreate', { params: { workspaceId: workspaceId.value }, body: channelState }),
  onSuccess: async (data) => { if (disposed) return; await bootstrap.refetch(); if (disposed) return; createOpen.value = false; await router.push(serverPath(workspaceId.value, data.id)); channelState.name = ''; channelState.topic = '' },
  onError: (cause) => { createError.value = apiError(cause) },
})
const ai = useMutation({
  mutationFn: (scope: { channelId: string; userId: string; workspaceId: string }) => api('aiAsk', { params: { channelId: scope.channelId } }),
  onSuccess: (message, scope) => { if (user.value?.id === scope.userId) return receiveMessage(queryClient, scope, message) },
  onError: showError,
})
const join = useMutation({
  mutationFn: (target: { id: string; name: string }) => api('huddleJoin', { params: { channelId: target.id } }),
  onSuccess: (data, target) => { huddle.value = { token: data.authToken, participantId: data.participantId, channelId: target.id, channel: target.name }; huddleOpen.value = true },
  onError: showError,
})
async function startHuddle() {
  if (huddle.value) { huddleOpen.value = true; return }
  if (channel.value && !join.isPending.value) join.mutate({ id: channel.value.id, name: channel.value.name })
}
async function leaveHuddle() {
  const active = huddle.value
  huddle.value = null; huddleOpen.value = false
  if (!active) return
  try { await api('huddleLeave', { params: { channelId: active.channelId, participantId: active.participantId } }) } catch (cause) { showError(cause) }
}
const members = computed(() => bootstrap.data.value?.members || [])
const onlineMembers = computed(() => members.value.filter((member) => onlineIds.value.includes(member.id)))
const offlineMembers = computed(() => members.value.filter((member) => !onlineIds.value.includes(member.id)))
const serverMenu = computed(() => [
  { label: 'Your connections', icon: 'i-lucide-network', onSelect: () => connections.show() },
  { label: 'Server Settings', icon: 'i-lucide-settings', onSelect: () => { settingsOpen.value = true } },
  ...(workspace.value?.role === 'owner' ? [{ label: 'Create Channel', icon: 'i-lucide-circle-plus', onSelect: () => { createOpen.value = true } }] : []),
])
const channelMenu = computed(() => [
  { label: `Members (${members.value.length})`, icon: 'i-lucide-users-round', onSelect: toggleMembers },
  ...(channel.value?.kind === 'text' ? [
    { label: 'Browse threads', icon: 'i-lucide-messages-square', onSelect: () => { threadsOpen.value = true } },
    { label: 'Ask AI about this conversation', icon: 'i-lucide-bot', onSelect: () => ai.mutate({ channelId: channelId.value, userId: user.value!.id, workspaceId: workspaceId.value }) },
  ] : []),
  { label: 'Start a voice huddle', icon: 'i-lucide-mic', disabled: !channel.value || join.isPending.value, onSelect: startHuddle },
])
function browseThreads() { sidebarOpen.value = false; threadsOpen.value = true }
function browseMembers() { sidebarOpen.value = false; toggleMembers() }
useEventListener('keydown', (event: KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!threadModalActive.value && !settingsOpen.value && !profileOpen.value) focusSearch() }
  if (event.key === 'Escape' && !event.defaultPrevented) {
    const overlay = document.activeElement?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')
    if (!overlay || overlay === navigation.value) { sidebarOpen.value = false; if (searchOpen.value) closeSearch() }
  }
  if (event.key === 'Tab' && isMobile.value && sidebarOpen.value && !document.activeElement?.closest('[role="menu"]')) {
    const topDialog = document.activeElement?.closest('[role="dialog"]')
    if (topDialog && topDialog !== navigation.value) return
    const controls = navigation.value?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), [tabindex="0"]')
    const first = controls?.[0], last = controls?.[controls.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
}, { capture: true })
useHead({ title: computed(() => `${channel.value ? '#' + channel.value.name + ' · ' : ''}${workspace.value?.name || 'Server'} · Anycord`) })
function newDay(index: number) { return index === 0 || new Date(messages.value[index - 1]!.createdAt).toDateString() !== new Date(messages.value[index]!.createdAt).toDateString() }
</script>

<template>
  <div class="workspace-client">
    <div v-if="auth.isPending.value" class="boot-screen" role="status"><BrandMark /><p>Opening your server…</p></div>
    <div v-else-if="auth.isError.value" class="boot-screen"><UIcon name="i-lucide-wifi-off" class="size-10" /><h1>Can’t reach your server</h1><p>{{ target.origin || 'The local server' }} may still be starting.</p><UButton @click="auth.refetch()">Try Again</UButton><UButton color="neutral" variant="ghost" @click="connections.show()">Switch installation</UButton></div>
    <div v-else-if="!user" class="boot-screen"><BrandMark /><p>Opening login…</p></div>
    <div v-else class="discord-shell" :class="{ 'keyboard-open': viewport.keyboard }" :style="{ '--visual-height': viewport.height ? `${viewport.height}px` : undefined, '--visual-top': `${viewport.top}px`, '--sidebar-width': `${sidebarWidth}px`, '--composer-bottom': `${composerLayout.bottom}px`, '--composer-height': `${composerLayout.height}px` }">
      <div class="desktop-titlebar" :inert="threadModalActive"><NuxtLink class="rail-brand" to="/servers" aria-label="Your servers"><BrandMark /></NuxtLink><form ref="searchInput" class="global-search" role="search" @submit.prevent="submitSearch"><UInput v-model="search" :placeholder="`Search ${workspace?.name || 'this server'}`" aria-label="Search this server" icon="i-lucide-search" variant="none" class="w-full" @keydown.esc.stop="closeSearch" /><kbd>⌘ K</kbd></form></div>
      <div class="workspace-layout">
        <div ref="navigation" class="workspace-navigation" :class="{ open: sidebarOpen }" :inert="threadModalActive || (isMobile && !sidebarOpen)" :role="isMobile && sidebarOpen ? 'dialog' : undefined" :aria-modal="isMobile && sidebarOpen ? true : undefined" aria-label="Servers and channels">
        <nav class="server-rail" aria-label="Servers"><NuxtLink class="mobile-rail-brand" to="/servers" aria-label="Your servers"><BrandMark /></NuxtLink><div class="mobile-rail-separator" />
          <UTooltip :text="`${connections.label.value} · ${installationHost}`" :content="{ side: 'right' }"><button class="installation-group" :aria-label="`Manage connections: ${connections.label.value}`" @click="connections.show()"><span>{{ connections.label.value }}</span><UIcon name="i-lucide-chevron-down" /></button></UTooltip>
          <UTooltip v-for="space in serverList.data.value" :key="space.id" :text="space.name" :content="{ side: 'right' }"><button class="server-icon" :class="{ selected: workspaceId === space.id }" :aria-label="space.name" @click="selectWorkspace(space.id)">{{ space.initials }}</button></UTooltip>
          <template v-if="serverList.isPending.value"><USkeleton v-for="i in 2" :key="i" class="size-12 rounded-2xl" /></template>
          <UTooltip v-if="serverList.isError.value" text="Retry loading your servers" :content="{ side: 'right' }"><button class="connection-home" aria-label="Retry server list" @click="serverList.refetch()"><UIcon name="i-lucide-refresh-cw" /></button></UTooltip>
          <UTooltip :text="user.role === 'owner' ? 'Add a Server' : 'Connect an installation'" :content="{ side: 'right' }"><button class="server-icon add-server" :aria-label="user.role === 'owner' ? 'Add a Server' : 'Connect an installation'" @click="connections.show(user.role === 'owner' ? 'choose' : 'remote')"><UIcon name="i-lucide-plus" /></button></UTooltip>
          <template v-if="connections.entries.length"><div class="rail-divider" /><span class="rail-group-label">REMOTE</span>
          <UTooltip v-for="item in connections.entries" :key="item.id" :text="item.name" :content="{ side: 'right' }"><button class="server-icon remote-icon" :class="{ selected: connections.active.value === item.id }" :aria-label="`Connect to ${item.name}`" @click="connections.select(item.id); router.push('/servers')">{{ item.name.slice(0, 2).toUpperCase() }}</button></UTooltip>
          </template>
        </nav>
        <aside ref="sidebar" class="channel-sidebar" :class="{ 'mobile-open': sidebarOpen }" aria-label="Channels">
          <div class="channel-heading"><UDropdownMenu :items="serverMenu"><button class="server-heading"><strong>{{ workspace?.name || 'Your server' }}</strong><UIcon :name="isMobile ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" /></button></UDropdownMenu><UButton class="mobile-close-channels" icon="i-lucide-x" aria-label="Close server navigation" color="neutral" variant="ghost" @click="sidebarOpen = false" /></div>
          <div class="mobile-server-toolbar"><button class="mobile-server-search" @click="focusSearch"><UIcon name="i-lucide-search" />Search</button><UButton icon="i-lucide-users-round" aria-label="Server members" color="neutral" variant="soft" @click="browseMembers" /><UButton icon="i-lucide-messages-square" aria-label="Threads in this channel" color="neutral" variant="soft" :disabled="channel?.kind !== 'text'" @click="browseThreads" /></div>
          <div class="channel-scroll">
            <div class="channel-category"><button class="category-toggle" :aria-expanded="textChannelsOpen" @click="textChannelsOpen = !textChannelsOpen">Text channels<UIcon :name="textChannelsOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" /></button><button v-if="workspace?.role === 'owner'" aria-label="Create text channel" @click="channelState.kind = 'text'; createError = ''; createOpen = true"><UIcon name="i-lucide-plus" /></button></div>
            <button v-for="item in channels.filter(c => c.kind === 'text')" v-show="textChannelsOpen" :key="item.id" class="channel-link" :class="{ active: channelId === item.id, unread: unread[item.id] }" :aria-current="channelId === item.id ? 'page' : undefined" @click="selectChannel(item)"><UIcon name="i-lucide-hash" /><span class="channel-name">{{ item.name }}</span><b v-if="unread[item.id]">{{ unread[item.id] }}</b><UIcon v-else-if="channelId === item.id" name="i-lucide-users-round" class="channel-tail" /></button>
            <div class="channel-category voice-category"><button class="category-toggle" :aria-expanded="voiceChannelsOpen" @click="voiceChannelsOpen = !voiceChannelsOpen">Voice channels<UIcon :name="voiceChannelsOpen ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" /></button><button v-if="workspace?.role === 'owner'" aria-label="Create voice channel" @click="channelState.kind = 'voice'; createError = ''; createOpen = true"><UIcon name="i-lucide-plus" /></button></div>
            <button v-for="item in channels.filter(c => c.kind === 'voice')" v-show="voiceChannelsOpen" :key="item.id" class="channel-link" :class="{ active: channelId === item.id }" @click="selectChannel(item)"><UIcon name="i-lucide-volume-2" /><span class="channel-name">{{ item.name }}</span></button>
            <div v-if="bootstrap.isPending.value" class="channel-loading"><USkeleton v-for="i in 4" :key="i" class="h-7 w-full" /></div>
          </div>
          <div v-if="huddle" class="voice-connection"><button @click="huddleOpen = true"><UIcon name="i-lucide-audio-lines" /><span>Huddle open<small>{{ huddle.channel }}</small></span></button><UButton icon="i-lucide-phone-off" aria-label="Disconnect huddle" color="neutral" variant="ghost" @click="leaveHuddle" /></div>
          <div class="user-panel"><button class="user-profile" aria-label="Open your account" @click="profileOpen = true"><span class="avatar small" :style="{ background: user.color }"><span>{{ user.name.slice(0, 2).toUpperCase() }}</span><i :class="{ disconnected: wsStatus !== 'OPEN' }" /></span><span class="user-details"><strong><span class="profile-name">{{ user.name }}</span><UIcon class="profile-chevron" name="i-lucide-chevron-down" /></strong><small>{{ wsStatus === 'OPEN' ? 'Online' : 'Connecting…' }}</small></span></button><div class="user-controls"><UTooltip :text="huddle ? 'Open microphone controls' : 'Microphone controls are available in a huddle'"><UButton icon="i-lucide-mic" variant="ghost" color="neutral" :disabled="!huddle" aria-label="Open microphone controls" @click="huddleOpen = true" /></UTooltip><UTooltip :text="huddle ? 'Open audio controls' : 'Audio controls are available in a huddle'"><UButton icon="i-lucide-headphones" variant="ghost" color="neutral" :disabled="!huddle" aria-label="Open audio controls" @click="huddleOpen = true" /></UTooltip><UTooltip text="User Settings"><UButton icon="i-lucide-settings" variant="ghost" color="neutral" aria-label="User Settings" @click="profileOpen = true" /></UTooltip></div></div>
        </aside>
        </div>
        <div v-if="!isMobile" class="sidebar-resizer" role="separator" aria-label="Resize channel sidebar" aria-orientation="vertical" :aria-valuenow="sidebarWidth" :aria-valuemin="200" :aria-valuemax="sidebarMax" tabindex="0" :inert="threadModalActive" @pointerdown="resizeSidebar" @keydown="resizeKey" @dblclick="savedSidebarWidth = 240" />
        <main class="chat-main" :inert="threadModalActive || (isMobile && sidebarOpen)">
          <header class="chat-header"><UButton class="mobile-menu" icon="i-lucide-arrow-left" color="neutral" variant="ghost" aria-label="Open channels" :aria-expanded="sidebarOpen" @click="sidebarOpen = true" /><UDropdownMenu v-if="isMobile" :items="channelMenu"><button class="mobile-channel-summary" aria-label="Channel details and actions"><span><UIcon :name="channel?.kind === 'voice' ? 'i-lucide-volume-2' : 'i-lucide-hash'" /><strong>{{ channel?.name || 'Your server' }}</strong><UIcon class="summary-chevron" name="i-lucide-chevron-right" /></span><small title="Online on this server"><i :class="{ connected: wsStatus === 'OPEN' }" />{{ wsStatus === 'OPEN' ? `${onlineMembers.length} Online` : 'Connecting…' }}</small></button></UDropdownMenu><UIcon :name="channel?.kind === 'voice' ? 'i-lucide-volume-2' : 'i-lucide-hash'" class="header-hash" /><h1 class="desktop-channel-title">{{ channel?.name || 'Your server' }}</h1><div class="header-divider" /><p class="channel-topic">{{ channel?.topic }}</p><div class="header-actions"><UButton class="mobile-search" icon="i-lucide-search" color="neutral" variant="ghost" aria-label="Search messages" @click="focusSearch" /><UTooltip text="Start a Huddle"><UButton class="desktop-header-action" icon="i-lucide-phone" variant="ghost" color="neutral" aria-label="Start a Huddle" :loading="join.isPending.value" :disabled="!channel" @click="startHuddle" /></UTooltip><UTooltip text="Members"><UButton class="desktop-header-action" icon="i-lucide-users-round" variant="ghost" color="neutral" aria-label="Toggle member list" :aria-pressed="narrowScreen ? memberDrawerOpen : membersVisible" @click="toggleMembers" /></UTooltip><UTooltip text="Threads"><UButton class="desktop-header-action" icon="i-lucide-messages-square" variant="ghost" color="neutral" aria-label="Browse threads" :disabled="channel?.kind !== 'text'" @click="threadsOpen = true" /></UTooltip></div></header>
          <div v-if="!online || wsStatus !== 'OPEN'" class="connection-banner" role="status">{{ !online ? 'You’re offline. Saved messages remain visible.' : 'Reconnecting to live chat…' }}</div>
          <div v-if="bootstrap.isError.value" class="content-error"><UAlert color="error" :title="apiError(bootstrap.error.value)" /><UButton @click="bootstrap.refetch()">Retry</UButton></div>
          <template v-else-if="channel?.kind === 'voice'">
            <div class="voice-empty"><div class="voice-orb"><UIcon name="i-lucide-volume-2" /></div><h2>{{ channel.name }}</h2><p>There’s always room for one more.</p><UButton size="lg" :loading="join.isPending.value" @click="startHuddle">Join Huddle</UButton><button class="subtle-link" @click="settingsOpen = true">Configure Cloudflare RealtimeKit</button></div>
          </template>
          <template v-else>
            <div v-if="focusMessageId" class="history-banner"><span>Viewing older messages</span><button @click="latestMessages">Jump to latest <UIcon name="i-lucide-arrow-down" /></button></div>
            <div ref="timeline" class="message-timeline" role="log" aria-label="Channel messages" aria-live="polite" aria-relevant="additions">
              <div class="channel-intro"><div class="channel-intro-icon"><UIcon name="i-lucide-hash" /></div><h2>Welcome to #{{ channel?.name || 'general' }}!</h2><p>This is the beginning of the <strong>#{{ channel?.name || 'general' }}</strong> channel.</p></div>
              <div v-if="messagesQuery.isPending.value" class="message-skeletons"><div v-for="i in 3" :key="i"><USkeleton class="size-10 rounded-full" /><span><USkeleton class="h-3 w-24" /><USkeleton class="h-4 w-72 max-w-full" /></span></div></div>
              <div v-else-if="messagesQuery.isError.value" class="content-error"><p>Messages couldn’t load. Your draft is safe.</p><UButton color="neutral" variant="outline" @click="messagesQuery.refetch()">Try again</UButton></div>
              <template v-for="(message, index) in messages" :key="message.id"><div v-if="newDay(index)" class="date-divider"><span>{{ new Date(message.createdAt).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) }}</span></div><MessageItem :message="message" :mine="message.authorId === user.id" :can-delete="message.authorId === user.id || workspace?.role === 'owner'" @edit="(text, done) => messageAction(message, 'PATCH', { text }).then(done)" @delete="done => messageAction(message, 'DELETE').then(done)" @react="messageAction(message, 'POST', { emoji: $event })" @reply="reply(message)" @quote="composer?.quote(message)" @thread="openThread(message)" @jump="jumpToMessage($event)" @copy-link="copyMessageLink(message)" /></template>
            </div>
            <ChatComposer ref="composer" :user-id="user.id" :workspace-id="workspaceId" :channel-id="channelId" :channel-name="channel?.name || 'general'" :reply-to="replyTo" :typing="typing" ai huddle :huddle-pending="join.isPending.value" @start-huddle="startHuddle" @clear-reply="replyTo = null" @sent="latestMessages" @typing="liveTyping" @ask-ai="ai.mutate({ channelId, userId: user.id, workspaceId })" @layout="!threadPanelActive && (composerLayout = $event)" />
          </template>
        </main>
        <ThreadDraftPanel v-if="threadPanelActive && threadTarget" :key="`${user.id}:${threadTarget.id}`" :target="threadTarget" :user-id="user.id" :modal="narrowThread" @close="closeThread" @created="threadCreated" @layout="composerLayout = $event" />
        <ThreadPanel v-else-if="threadPanelActive && threadId" :workspace-id="workspaceId" :channel-id="channelId" :thread-id="threadId" :user="user" :owner="workspace?.role === 'owner'" :modal="narrowThread" :focus-id="focusedId" :typing="threadTyping" @close="closeThread" @jump="jumpToMessage($event, threadId)" @typing="liveTyping" @copy-link="copyMessageLink" @layout="composerLayout = $event" />
        <aside v-if="searchOpen && !threadPanelActive" class="search-panel" aria-label="Search results"><header class="thread-header"><h2>Search results</h2><UButton icon="i-lucide-x" aria-label="Close search" variant="ghost" color="neutral" @click="closeSearch" /></header><form v-if="isMobile" ref="mobileSearchInput" class="mobile-search-form" role="search" @submit.prevent="submitSearch"><UInput v-model="search" aria-label="Search this server" :placeholder="`Search ${workspace?.name || 'this server'}`" icon="i-lucide-search" class="w-full" @keydown.esc.stop="closeSearch" /></form><div class="search-results"><p v-if="!debouncedSearch.trim()">Type a message to search for, then press Enter.</p><p v-else-if="search !== debouncedSearch || searchResults.isPending.value">Searching…</p><p v-else-if="searchResults.isError.value">Could not search. <button @click="searchResults.refetch()">Retry</button></p><template v-else><p>{{ searchResults.data.value?.length || 0 }} results for “{{ debouncedSearch }}”</p><button v-for="result in searchResults.data.value" :key="result.id" @click="router.push({ path: serverPath(workspaceId, result.channelId), query: { thread: result.threadId || undefined }, hash: `#message-${result.id}` }); searchOpen = false"><small>#{{ result.channel }} · {{ result.author }}</small><span>{{ result.text }}</span><b>Jump to message</b></button></template></div></aside>
        <aside v-if="membersVisible && !threadPanelActive && !searchOpen" class="member-sidebar" aria-label="Server members"><div v-if="onlineMembers.length" class="member-section"><h2>ONLINE — {{ onlineMembers.length }}</h2><button v-for="member in onlineMembers" :key="member.id" class="member-row" @click="toast.add({ title: member.name, description: member.workspaceRole === 'owner' ? 'Server owner' : 'Server member' })"><span class="avatar small" :style="{ background: member.color }">{{ member.name.slice(0, 2).toUpperCase() }}<i /></span><span>{{ member.name }}</span><UIcon v-if="member.workspaceRole === 'owner'" name="i-lucide-crown" class="owner-crown" /></button></div><div v-if="offlineMembers.length" class="member-section offline-members"><h2>OFFLINE — {{ offlineMembers.length }}</h2><button v-for="member in offlineMembers" :key="member.id" class="member-row" @click="toast.add({ title: member.name, description: 'Offline' })"><span class="avatar small" :style="{ background: member.color }">{{ member.name.slice(0, 2).toUpperCase() }}<i /></span><span>{{ member.name }}</span></button></div><p v-if="!members.length" class="member-empty">Your server members will appear here.</p></aside>
      </div>
    </div>
    <UModal v-model:open="memberDrawerOpen" title="Server Members" :description="workspace?.name || 'Your server'"><template #body><div class="member-section"><h2>ONLINE — {{ onlineMembers.length }}</h2><div v-for="member in onlineMembers" :key="member.id" class="member-row"><span class="avatar small" :style="{ background: member.color }">{{ member.name.slice(0, 2).toUpperCase() }}<i /></span><span>{{ member.name }}</span></div></div><div class="member-section offline-members"><h2>OFFLINE — {{ offlineMembers.length }}</h2><div v-for="member in offlineMembers" :key="member.id" class="member-row"><span class="avatar small" :style="{ background: member.color }">{{ member.name.slice(0, 2).toUpperCase() }}<i /></span><span>{{ member.name }}</span></div></div></template></UModal>
    <UModal v-model:open="threadsOpen" title="Threads" :description="`Conversations in #${channel?.name || 'general'}`"><template #body><div class="thread-list"><p v-if="threadsQuery.isPending.value">Loading threads…</p><p v-else-if="threadsQuery.isError.value">Could not load threads. <button @click="threadsQuery.refetch()">Retry</button></p><p v-else-if="!threadsQuery.data.value?.length">No threads yet. Open a message’s menu and choose Create Thread.</p><button v-for="item in threadsQuery.data.value" :key="item.id" @click="router.push({ query: { ...route.query, thread: item.id }, hash: '' }); threadsOpen = false"><UIcon name="i-lucide-messages-square" /><span><strong>{{ item.name }}</strong><small>{{ item.messageCount }} messages</small></span><UIcon name="i-lucide-chevron-right" /></button></div></template></UModal>
    <UserSettings v-if="user" v-model:open="profileOpen" :user="user" @logout="logout().then(() => { profileOpen = false })" />
    <SettingsDialog v-if="user" v-model:open="settingsOpen" :owner="user.role === 'owner'" :workspace="workspace" :channels="channels" :members="members" />
    <UModal v-model:open="createOpen" title="Create Channel" description="Give your conversation a place of its own."><template #body><UForm :schema="channelSchema" :state="channelState" @submit="createChannel.mutate()" class="dialog-form"><UFormField label="CHANNEL TYPE" name="kind"><URadioGroup v-model="channelState.kind" :items="[{ label: 'Text', value: 'text', description: 'Send messages and share ideas' }, { label: 'Voice', value: 'voice', description: 'Hang out in a live huddle' }]" /></UFormField><UFormField label="CHANNEL NAME" name="name"><UInput v-model="channelState.name" placeholder="new-channel" icon="i-lucide-hash" class="w-full" /></UFormField><UFormField label="TOPIC" name="topic"><UInput v-model="channelState.topic" placeholder="What’s this channel about?" class="w-full" /></UFormField><UAlert v-if="createError" color="error" :title="createError" /><UButton type="submit" :loading="createChannel.isPending.value">Create Channel</UButton></UForm></template></UModal>

    <UModal v-model:open="huddleOpen" title="Live Huddle" description="Cloudflare RealtimeKit" :dismissible="false" :close="false" :ui="{ content: 'max-w-6xl', body: 'p-0 sm:p-0' }"><template #body><HuddlePanel v-if="huddle" :token="huddle.token" :channel="huddle.channel" @leave="leaveHuddle" /></template></UModal>
  </div>
</template>

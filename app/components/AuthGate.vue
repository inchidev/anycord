<script setup lang="ts">
const api = apiFor()
import { credentialsSchema } from '../../shared/contracts'
import { apiFor } from '../utils/api'
const props = defineProps<{ initialized: boolean; setupRequired?: boolean }>()
const emit = defineEmits<{ authenticated: [] }>()
const { $connections: connections } = useNuxtApp()
const remote = computed(() => !!connections.current.value)
const route = useRoute(), router = useRouter()
const register = computed({ get: () => !remote.value && (!props.initialized || route.query.mode === 'register'), set: value => { void router.replace({ query: { ...route.query, mode: value ? 'register' : undefined } }) } })
const state = reactive({ name: '', password: '', setupCode: new URLSearchParams(location.hash.slice(1)).get('setup') || '' })
onMounted(() => { if (location.hash.startsWith('#setup=')) void router.replace({ query: route.query, hash: '' }) })
const pending = ref(false)
const error = ref('')
let disposed = false
onBeforeUnmount(() => { disposed = true })
useHead({ title: computed(() => `${register.value ? 'Create an account' : 'Log in'} · Anycord`) })
async function submit() {
  const connectionId = connections.active.value
  pending.value = true; error.value = ''
  try {
    if (remote.value) { const result = await api('connectionLogin', { body: state }); if (disposed || connectionId !== connections.active.value) return; connections.authenticate(result.token) }
    else await api(register.value ? 'authRegister' : 'authLogin', { body: state })
    state.password = ''
    if (!disposed && connectionId === connections.active.value) emit('authenticated')
  } catch (cause: unknown) { error.value = apiError(cause) }
  finally { pending.value = false }
}
</script>

<template>
  <main class="auth-screen">
    <NuxtLink to="/" class="auth-brand" aria-label="Anycord home"><BrandMark wordmark /></NuxtLink>
    <section class="auth-card">
      <h1>{{ remote ? 'Log in to your installation' : !initialized ? 'Create the first account' : register ? 'Create an account' : 'Welcome back.' }}</h1>
      <p>{{ remote ? connections.current.value?.origin : !initialized ? 'This account will own this installation. You’ll choose a server next.' : register ? 'Create your account, then choose a server.' : 'Log in, then choose a server to open.' }}</p>
      <UForm :schema="credentialsSchema" :state="state" @submit="submit">
        <UFormField name="name" label="USERNAME" required><UInput v-model="state.name" autofocus autocomplete="username" class="w-full" /></UFormField>
        <UFormField name="password" label="PASSWORD" required :description="register ? 'At least 10 characters.' : undefined"><UInput v-model="state.password" type="password" :autocomplete="register ? 'new-password' : 'current-password'" class="w-full" /></UFormField>
        <UFormField v-if="setupRequired && !remote" name="setupCode" label="SETUP CODE" description="The owner’s private setup link fills this in automatically." required><UInput v-model="state.setupCode" type="password" autocomplete="off" class="w-full" /></UFormField>
        <UAlert v-if="error" color="error" :title="error" />
        <UButton type="submit" :loading="pending" block size="lg">{{ register ? 'Create account' : 'Log in' }}</UButton>
      </UForm>
      <p v-if="initialized && !remote" class="auth-switch">{{ register ? 'Already have an account?' : 'Need an account?' }} <button @click="register = !register; error = ''">{{ register ? 'Log in' : 'Register' }}</button></p>
      <p v-if="remote" class="auth-switch">Need an account? <a :href="`${connections.current.value?.origin}/login?mode=register`" target="_blank" rel="noopener noreferrer">Register on this installation</a></p><UButton variant="ghost" color="neutral" @click="connections.show()">Use a different installation</UButton>
    </section>
    <p class="auth-note">Your account belongs to this installation.</p>
  </main>
</template>

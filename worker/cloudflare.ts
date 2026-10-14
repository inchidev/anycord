import { createD1Handler } from './router'
export { WorkspaceHub } from './hub'
export { ChatRoom } from './legacy.js'

// Cloudflare deployment entrypoint. It requires real D1/DO/assets bindings.
export default createD1Handler('cloudflare')

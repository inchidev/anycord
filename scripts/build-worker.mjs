import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
await mkdir('runtime', { recursive: true })
// Keep native AsyncLocalStorage for request isolation, but use the official JS
// password implementation because celld does not provide node:crypto.scrypt.
const passwordFallback = fileURLToPath(new URL('./password.mjs', import.meta.resolve('@better-auth/utils/password')))
await build({ entryPoints: ['worker/index.ts'], outfile: 'runtime/worker.js', bundle: true, format: 'esm', target: 'es2022', conditions: ['workerd', 'worker', 'browser'], alias: { '@better-auth/utils/password': passwordFallback }, external: ['cloudflare:*', 'node:*'], sourcemap: 'external' })
// Build the real Cloudflare entry independently; provisioning its bindings is a deployment step.
await build({ entryPoints: ['worker/cloudflare.ts'], outfile: 'runtime/cloudflare/worker.js', bundle: true, format: 'esm', target: 'es2022', conditions: ['workerd', 'worker', 'browser'], alias: { '@better-auth/utils/password': passwordFallback }, external: ['cloudflare:*', 'node:*'], sourcemap: 'external' })
const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'))
config.main = 'worker.js'
config.no_bundle = true
await writeFile('runtime/wrangler.jsonc', JSON.stringify(config, null, 2))

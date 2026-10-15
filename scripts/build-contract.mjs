import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'

await mkdir('runtime', { recursive: true })
await build({
  stdin: { contents: "export * from './shared/apps'; export * from './shared/permissions'; export * from './shared/api'; export * from './shared/contracts'; export * from './shared/client'; export * from './shared/emoji'; export * from './shared/message-text'; export * from './shared/drafts'", resolveDir: process.cwd(), loader: 'ts' },
  outfile: 'runtime/contracts.mjs', bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
})
await build({ entryPoints: ['shared/operations.ts'], outfile: 'runtime/operations-contracts.mjs', bundle: true, format: 'esm', platform: 'neutral', target: 'es2022' })

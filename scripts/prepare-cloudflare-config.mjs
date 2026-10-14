import { readFile,writeFile,mkdir } from 'node:fs/promises'
const config = JSON.parse(await readFile('wrangler.cloudflare.jsonc','utf8'))
config.main = 'worker.js'
config.no_bundle = true
config.account_id = 'ee47884b4794b0240647bfa7a3e56c0b'
config.assets.directory = '../../.output/public'
config.d1_databases[0].migrations_dir = '../../drizzle'
config.routes = [{pattern:'anycord.inchi.dev',custom_domain:true}]
await mkdir('runtime/cloudflare',{recursive:true})
await writeFile('runtime/cloudflare/wrangler.jsonc',JSON.stringify(config,null,2))

import { readFile, writeFile, readdir } from 'node:fs/promises'
const files = (await readdir('drizzle')).filter((file) => file.endsWith('.sql')).sort()
const migrations = await Promise.all(files.map(async (file) => ({
  name: file.replace(/\.sql$/, ''),
  statements: (await readFile(`drizzle/${file}`, 'utf8')).split('--> statement-breakpoint').map((statement) => statement.trim()).filter(Boolean),
})))
await writeFile('worker/migrations.json', JSON.stringify(migrations, null, 2) + '\n')
console.log(`Bundled ${migrations.length} SQL migrations`)

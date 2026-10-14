import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'))
let commit = 'development'
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch {}
const version = process.env.ANYCORD_RELEASE_VERSION || pkg.version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Release version must be stable semver (X.Y.Z)')
const info = { version, commit, apiVersion: 1, schema: journal.entries.at(-1).tag }
await writeFile('shared/build-info.json', JSON.stringify(info, null, 2) + '\n')

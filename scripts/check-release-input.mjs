import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
const version = process.env.ANYCORD_RELEASE_VERSION
assert(/^\d+\.\d+\.\d+$/.test(version || ''), 'Version must be stable semver X.Y.Z')
assert(process.env.GITHUB_REF === 'refs/heads/main', 'Release workflow must run from main')
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const parts = value => value.split('.').map(Number)
const compare = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0 }
assert(compare(parts(version), parts(pkg.version)) >= 0, 'Release version is older than package.json')
const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).trim().split('\n').filter(tag => /^v\d+\.\d+\.\d+$/.test(tag))
for (const tag of tags) assert(compare(parts(version), parts(tag.slice(1))) > 0, `Version must be newer than ${tag}; tags are immutable`)
assert(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() === '', 'Release source must be clean')

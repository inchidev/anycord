import assert from 'node:assert/strict'
import { appendFile, readFile } from 'node:fs/promises'
import { authorize, githubClient, previewIdentity, repository, validatePull } from './preview-policy.mjs'
assert.equal(process.env.GITHUB_REPOSITORY, repository)
assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Run the trusted workflow from main')
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
const github = githubClient()
const automatic = process.env.GITHUB_EVENT_NAME === 'pull_request_target'
let pr, sha, operation
if (automatic) {
  assert.equal(event.action, 'closed', 'Automatic preview deployment is forbidden')
  pr = event.pull_request.number
  validatePull(await github(`/repos/${repository}/pulls/${pr}`), pr, null, { closed: true })
  operation = 'destroy'; sha = ''
} else {
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch')
  pr = event.inputs.pr; sha = event.inputs.sha || ''; operation = event.inputs.operation
  assert(['deploy', 'destroy'].includes(operation))
  await authorize(github, { actor: process.env.GITHUB_ACTOR, triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR, pr, sha,
    closed: operation === 'destroy' && (await github(`/repos/${repository}/pulls/${previewIdentity(pr).pr}`)).state === 'closed' })
}
await appendFile(process.env.GITHUB_OUTPUT, `pr=${previewIdentity(pr).pr}\nsha=${sha}\noperation=${operation}\n`)
console.log(`Authorized ${operation} for preview PR #${pr}${sha ? ` at ${sha}` : ''}`)

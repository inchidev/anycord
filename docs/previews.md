# PR previews

In GitHub Actions, run **PR preview** from **main**, enter the PR number, its exact reviewed 40-character head SHA and `deploy`. Only collaborators whose current GitHub `role_name` is **maintain** or **admin** can launch it. The original actor and the actor requesting a rerun are both checked, before building and again before deployment. Write/Triage/Read roles are rejected. Pushes, PR opening and PR updates do not deploy previews. A changed head requires a new launch with its new SHA.

Example: `gh workflow run preview.yml --ref main -f pr=16 -f sha=<reviewed-head-sha> -f operation=deploy`.

The run summary and GitHub `preview` environment show `https://anycord-pr-16.ij69.workers.dev`. This URL is public; launching is restricted, viewing is not. Test data and separate test provider credentials only. Never enter production passwords, keys, bot tokens or customer data into a preview. A dedicated Telegram test bot can use this origin for OIDC/webhook/Mini App acceptance in #16. Connecting a bot changes that bot's webhook, so do not reuse the production bot.

## Isolation

- The workflow and provisioning scripts come from the immutable workflow commit on `main`. PR code builds on a separate disposable GitHub runner, with read-only repository access, no environment and no Cloudflare/application secrets. Fork code is allowed only after a maintainer explicitly selects its SHA.
- Only the prebuilt `worker.js` and static `public/` files cross to the deployment runner. The trusted deployment does not execute PR scripts, dependencies or Wrangler config. It rejects symlinks, unexpected artifact roots, oversized artifacts and mismatched source identity, then constructs an allowlisted config.
- Each PR owns a separate Worker `anycord-pr-N`, D1 `anycord-pr-N`, private R2 bucket `anycord-pr-N-files` and local DO namespaces. No production routes, DB, bucket, DO bindings, secrets or data copies are used. The production D1 ID is explicitly rejected. CPU time is limited to 1000ms; preview background retries run once per minute.
- The `preview` GitHub environment must allow deployment from exactly the `main` branch. Cloudflare credentials are available only there; the `production` environment holds production promotion credentials separately. Do not retain a repository-level `CLOUDFLARE_API_TOKEN` accessible to other workflows. The Cloudflare deployment credential is account-scoped and held only by trusted deployment code; resource isolation does not mean a leaked deployment token would be harmless. A separate Cloudflare account is the stronger account-level boundary.
- Automatic native Cloudflare Builds PR previews remain disabled. The main Cloudflare build remains verification-only. No merge, tag, production promotion or production migration is part of preview deployment.

Preview updates preserve that PR's test data and derived keys. A deliberately destroyed/recreated preview starts empty. After closing/merging a PR, `pull_request_target: closed` runs only trusted cleanup from main; it does not check out or execute PR code. It removes the Worker and DO namespaces, empties/deletes the private R2 bucket and deletes its D1 database. Manual `destroy` is also available to Maintain/Admin. Destroy is permanent for test data. If provisioning/cleanup fails, rerun the same operation; failures are not reported as successful cleanup.

## Environment setup and owner access

Create GitHub environment `preview` with a custom deployment branch policy allowing only `main`. Store `CLOUDFLARE_API_TOKEN` there, with account-scoped Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit and Workers Subdomain Read (or equivalent account worker read capability). No zone/DNS/Routes, user token editing, or production migration secret is needed. Preserve the separate `production` environment and its existing migration token.

Store an independent random 32-byte hex value as `PREVIEW_SECRET_SEED` in `preview` and in the maintainers' secret manager. APP_SECRET, MIGRATION_TOKEN and SETUP_TOKEN are derived with HMAC-SHA256 over `anycord-preview:<PR>:<SECRET_NAME>`. They are stable across updates, different per PR and never derived from production keys. The seed itself is never a Worker binding. Do not rotate it casually: doing so invalidates preview sessions/encrypted provider configuration.

Derive an individual setup code locally using `previewSecrets(seed, pr)` from `scripts/preview-policy.mjs`, reading the seed from a secret manager or private file, and open `/login#setup=<SETUP_TOKEN>` to create the owner. Do not put setup links in public PR comments, workflow summaries or artifacts. Every preview starts with the existing application's first-owner setup gate. Additional accounts follow its registration policy. Share private setup information only with the intended tester.

For an existing repository secret, **Scope existing Cloudflare credential** is a one-time Admin-only helper: supply the two GitHub environment public keys. It outputs only sealed-box ciphertext encrypted for those environments. An administrator stores each ciphertext via GitHub's environment secret API with its matching key ID, verifies both secret names exist, then deletes the repository-level secret. The helper cannot decrypt credentials or grant itself environment administration. Once the repository secret is removed it fails closed. Prefer independent preview/production tokens when provisioning new credentials.

## Validation

`node --test scripts/test-preview-policy.mjs` checks role/rerun denial, stale/closed/wrong-repository PRs, strict resource names, production D1 rejection, config allowlisting and credential separation. Deployments additionally check migration/health/source/schema, public version identity and PWA routes. Validate authenticated flows and provider behavior on the preview using designated test accounts; a successful build alone is not deployment acceptance.

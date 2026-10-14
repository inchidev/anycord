# Deployment

## Git and verification

The source repository is [inchidev/anycord](https://github.com/inchidev/anycord). GitHub Actions runs `npm ci` and `npm run verify` on pushes and pull requests, using Node.js 22. This workflow checks and builds the application; it does not deploy it.

Existing production releases at `https://anycord.inchi.dev` were published directly with Wrangler. Automatic deployment from Git is **pending**: Cloudflare's repository-connection API rejected the initial connection with error `8000008`, because its GitHub integration has not authorized this repository. A successful GitHub check alone is not evidence of a production deployment.

## Connect Cloudflare Workers Builds

An organization administrator must grant the **Cloudflare Workers and Pages** GitHub App access to `inchidev/anycord`. Review the organization's installed apps at <https://github.com/organizations/inchidev/settings/installations>. Preserve access to unrelated repositories.

In the existing `anycord` Worker's **Settings → Builds**, connect that repository and configure:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | Repository root |
| Build command | `npm run verify && node scripts/prepare-cloudflare-config.mjs` |
| Deploy command | `npx wrangler deploy --config runtime/cloudflare/wrangler.jsonc && node scripts/verify-deployment.mjs` |
| Non-production branch deploys | Disabled until isolated preview resources are configured |

Use the existing Worker and bindings; creating a server inside Anycord does not require another deployment. Workers Builds installs dependencies. Configure an appropriately scoped build API token through Cloudflare and store the existing `MIGRATION_TOKEN` as a secret **build variable** as well as a runtime secret. The verification command applies application migrations when that variable is present, then checks the live schema, routes and logo asset.

Keep the existing runtime `APP_SECRET`, `MIGRATION_TOKEN`, `SETUP_TOKEN` and `AUTH_BASE_URL`. Never replace production keys with development placeholders. Build variables and runtime Worker secrets are separate. Application migrations use the authenticated `/api/_migrate` endpoint; `wrangler d1 migrations apply` is not the application migration procedure.

After connecting, prove the entire path with a real commit: push → successful GitHub verification → successful Workers build/deploy → healthy production version → browser verification. Do not call Git deployment active before this succeeds.

Official documentation: [GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/) and [Build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

## Another Cloudflare installation

`wrangler.cloudflare.jsonc` and `scripts/prepare-cloudflare-config.mjs` currently target the existing Anycord installation. For a separate installation, configure your own account, Worker name, D1 database, R2 bucket and custom domain before deploying. Set fresh runtime secrets for that installation; do not copy another installation's encryption/signing keys. The Worker serves both the shared API and generated frontend assets without a Nitro server.

## Local state and secrets

Git excludes `.env*`, `.dev.vars`, `.backups/`, `.celld/`, generated bundles and screenshots. Production operational files are deliberately absent. Store secrets in Cloudflare or your self-hosted secret manager and back up the database, files and encryption key together.

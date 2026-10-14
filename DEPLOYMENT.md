# Deployment

## Git, releases and production promotion

All changes go through PRs to protected `main`. GitHub Actions runs `npm ci` and `npm run verify`; the Cloudflare main-branch build verifies only and does not deploy. Merging and publishing do not update production or tenant installations.

Use **Publish release** to produce a new immutable stable version with prebuilt Cloudflare and celld packages, release notes and checksums. Then use **Promote production release** to deploy the exact published artifact to the existing reference installation. The promotion workflow needs the `production` environment secrets `CLOUDFLARE_API_TOKEN` and the existing `MIGRATION_TOKEN`; these are not automatically inherited from Cloudflare Workers Builds. See [release, installation and recovery procedures](docs/releases.md).

The Workers Builds connection may stay on `main` with build command `npm run verify` and deploy command `node -e "console.log('Verification only; promote a published release explicitly')"`. Keep non-production deployment disabled until isolated previews (#2) exist. Never leave the previous auto-deploy command enabled when adopting this workflow.

Preserve existing runtime APP_SECRET, MIGRATION_TOKEN, SETUP_TOKEN and AUTH_BASE_URL. Build variables and runtime secrets are separate. Application migrations use the authenticated `/api/_migrate` endpoint; `wrangler d1 migrations apply` is not the application migration procedure. Check release identity and live behavior separately from CI success.

## Another Cloudflare installation

`wrangler.cloudflare.jsonc` and `scripts/prepare-cloudflare-config.mjs` currently target the existing Anycord installation. For a separate installation, configure your own account, Worker name, D1 database, R2 bucket and custom domain before deploying. Set fresh runtime secrets for that installation; do not copy another installation's encryption/signing keys. The Worker serves both the shared API and generated frontend assets without a Nitro server.

## Local state and secrets

Git excludes `.env*`, `.dev.vars`, `.backups/`, `.celld/`, generated bundles and screenshots. Production operational files are deliberately absent. Store secrets in Cloudflare or your self-hosted secret manager and back up the database, files and encryption key together.

Nuxt explicitly uses the `static` build preset so Cloudflare CI detection cannot generate a separate Nitro runtime. The deployed entry point is the application Worker bundle selected by `--config runtime/cloudflare/wrangler.jsonc`; the root `wrangler.jsonc` is for celld and is not a production deployment config.

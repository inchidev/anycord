# Releases and recovery

All source changes go through a PR to `main`. GitHub's required `check` job verifies the application. [PR previews](previews.md) are explicitly launched from main by Maintain/Admin for a reviewed SHA, using isolated resources. Automatic Cloudflare PR previews remain disabled. GitHub requires approval for all external fork contributors. The Cloudflare main-branch build is verification-only: its deploy command is `node -e "console.log('Verification only; promote a published release explicitly')"`. Neither merging nor publishing updates tenant installations.

## Publish

Run **Publish release** from `main` with a new stable `X.Y.Z` version, at least the package version and newer than all existing stable tags. The workflow verifies/builds one source commit, packages the already-built client, Worker and migrations for both engines, and records app/API/schema versions and SHA-256 checksums. It creates a fresh `vX.Y.Z` tag and uploads all assets to a draft release before publishing it as latest. Enable GitHub immutable releases for this repository; published releases and their tags must never be replaced.

Assets:

- `anycord-X.Y.Z-cloudflare.tar.gz`: prebuilt Worker/client, SQL migrations, deployment config template, configure/verification scripts.
- `anycord-X.Y.Z-celld.tar.gz`: prebuilt Worker/client, migrations, ws runtime dependency, start script and a Dockerfile using celld 0.6.2. Building this image packages the existing build; it does not rebuild application source.
- `anycord-release.json`: source commit, app/API/schema versions, supported engines and package hashes/sizes.
- `SHA256SUMS`: checksums for both packages and the manifest.

Both packages include `operations/` with bundled contracts and `OPERATIONS.md`. `release-upgrade.json` declares supported source schemas and migration compatibility in the manifest; keep it current when adding migrations. API compatibility alone does not approve a schema upgrade.

A failure before publication leaves a draft and reserved tag, not a new stable release. Inspect it and publish a new version after fixing the problem. Do not delete/move a published or reserved tag to rerun a release. Use the separate manual PR preview workflow for hosted acceptance; previews are not releases or tenant updates.

## Promote the reference installation

Run **Promote production release** from main with an existing immutable stable tag. It downloads and verifies the published packages and deploys their exact Worker/client; it never builds application code from the latest main. The `production` environment needs a scoped `CLOUDFLARE_API_TOKEN` and the existing installation's `MIGRATION_TOKEN`. These are separate from Cloudflare Workers Builds secrets; configure them before the first promotion. Missing credentials fail before deployment. Review `installation.json` for the intended account, Worker, D1, private R2 bucket and origin. Existing runtime APP_SECRET/MIGRATION_TOKEN/SETUP_TOKEN are preserved.

Before promotion, create and verify a recovery point covering database, attachments and encryption keys. Installations with migration `0011_fancy_vanisher` can use the [operator backup/restore runner](operations.md); older installations need their existing operational backup procedure for the one-time bootstrap. Existing accounts, data and domains must remain in place. Promotion applies application migrations through the authenticated `/api/_migrate` endpoint, then verifies health/schema and the exact client/Worker version and source commit. It does not use `wrangler d1 migrations apply`.

After promotion, verify signed-in account access, two-client message/realtime delivery and private attachment access using designated test accounts. The public verification script proves release identity/schema/routes, not these authenticated scenarios.

## Independent installation

Download a specific stable release and check `SHA256SUMS` before extraction. Back up an existing installation before changing it. Do not copy another installation's secrets.

For Cloudflare, extract the Cloudflare package, create an installation JSON with `accountId`, `workerName`, `databaseId`, `databaseName`, `bucketName`, `origin` and optional `customDomain`, then run `node configure.mjs /absolute/path/installation.json`. Provision the named D1/private R2/Worker and set fresh APP_SECRET, MIGRATION_TOKEN and SETUP_TOKEN for a new installation. Deploy with the pinned Wrangler version from this release's source package-lock, then run `ANYCORD_URL=https://your.origin MIGRATION_TOKEN=... node verify-deployment.mjs` using a secret manager rather than putting tokens in shell history. Keep existing secrets on upgrades.

For celld, extract its package and run `docker build -t anycord:X.Y.Z .`. Mount the existing `.celld` state directory/volume at `/app/.celld`, preserve S3-compatible attachment storage and configuration, and set AUTH_BASE_URL to the installation's HTTPS origin. The start script retains the encryption and migration keys, boots celld and applies migrations. A new installation gets fresh keys. After bootstrapping migration `0011_fancy_vanisher`, connect the [operations runner](operations.md) and choose a compatible immutable release in Installation Settings → Backups & updates. Updates require a verified checkpoint and preserve the existing resources and secrets.

## Compatibility, failed upgrades and hotfixes

`GET /api/runtime`, `GET /api/health` and public `/version.json` expose the exact release identity. The API version is independent of the app version. Make backward-compatible API changes within API v1; introduce a new API version for incompatible changes. Clients verify API compatibility before mutations/uploads. Do not silently send writes to a newer incompatible backend.

Prefer additive migrations and an overlap period where prior clients still work. PWA clients keep a consistent cached client until the user chooses Update now; updates preserve saved drafts and wait for pending sends/uploads. Do not force old clients to reload mid-composition.

For a compatible code rollback, explicitly promote an older immutable release only after checking its schema compatibility. If the database changed incompatibly, a Worker rollback alone is insufficient: stop writes, restore the matching database/files/keys from the verified recovery point, then promote the matching release. State expected data loss/recovery point. Hotfixes follow the same PR, validation, new-version publication and promotion flow; never move a protected release tag.

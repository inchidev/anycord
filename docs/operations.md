# Installation backups and updates

Installation Settings → Backups & updates manages every community, account and committed private file in the installation. Only the installation owner can configure storage, request operations or recover keys. A community owner does not control the installation.

Backups run inside the installation and upload directly to a **separate private S3-compatible bucket**. No always-on external runner is required. Updates first verify an encrypted S3 recovery point, then start a temporary cloud deployment job. Owners explicitly choose a compatible immutable GitHub Release; merging or publishing does not update installations automatically.

This mode requires migration `0012_separate_s3_backups`. Install 0.6.0 once using the existing published-package promotion procedure. The previous filesystem operator remains available for advanced/manual recovery and older installations.

## Configure backup storage

In Installation Settings → Backups & updates, enter a dedicated S3 endpoint, bucket, region and access/secret key pair. Use credentials scoped to this backup bucket. The bucket and credentials must be independent of the attachment store, including historical stores still holding committed files. Configuration verifies write/read/delete access and rejects aliases of the physical attachment bucket. Cloudflare requires HTTPS; local celld also accepts HTTP endpoints. Providers must support path-style S3 requests.

For R2, create a separate private bucket, an **Object Read & Write** token scoped to it, endpoint `https://<account-id>.r2.cloudflarestorage.com` and region `auto`. Keep public access disabled. No additional application R2 binding is needed: the backup engine uses the configured S3 endpoint. Changing backup storage does not move attachments.

Save the displayed **64-character recovery key** in an external password manager. It encrypts backup payloads and authenticates their inventory. Losing the installation and this key makes encrypted recovery impossible. The owner can export it again after entering their current account password. Storage changes preserve the recovery key; keep old bucket access available for older recovery points. Ordinary status responses never expose storage secrets, the key or raw account records.

Use Create backup for an immediate copy, or set the interval in hours; 0 disables scheduling. The existing installation cron starts one overdue backup when idle. Durable alarms checkpoint progress, retry transient storage failures and resume after a runtime restart. A cancelled backup cannot become a verified recovery point. Five failed attempts stop the operation and release its write pause when deployment has not started.

Choose at least two retained recovery points. Retention removes only catalogued, verified copies belonging to this installation, from their recorded destinations. Interrupted-update checkpoints remain pinned in addition to recent copies. Foreign objects and partial uploads are left untouched. Cancelled/failed partial uploads can be inspected and removed separately; provider lifecycle/version retention is independent of this policy.

The privileged operator protocol also accepts `PUT /api/_operations/backup-storage` and `PUT /api/_operations/cloud-updates` with the same validated configuration bodies and `X-Migration-Token`. Use a protected input file or secret manager for provisioning. These endpoints grant the same capabilities as the owner UI and require the installation's existing migration token; cross-origin requests are refused.

## Backup format and consistency

S3 copies live under `anycord-backups/<installation-id>/<backup-id>/`. Format 2 `manifest.json` records the exact application/API/schema/source identity, table columns/counts, bounded table parts, committed attachments and encoded/plaintext SHA-256/size inventories. Payloads use AES-256-GCM with independent random nonces. An HMAC authenticates the manifest's metadata and file mappings. The manifest exposes inventory metadata, not record or file contents. Every uploaded payload is read back, hashed and decrypted before it is accepted; the authenticated manifest is written last and verified before recording the recovery point.

The encrypted payloads include account/password records, communities, messages, roles, channel overrides, app profiles/grants, webhook hashes, message receipts, committed attachment bytes and the installation keys required to recover encrypted settings. Settings secrets remain encrypted by the installation key inside the encrypted backup. Recovery files are sensitive even when encrypted: keep the bucket private and the recovery key separate.

A maintenance fence pauses new chat/API writes. SQLite triggers also reject writes from requests already in flight while snapshot-owned tables are copied. Data is paged by rowid and committed files are immutable. Sessions, OAuth challenges, live tickets, calls, command invocations, pending notification deliveries and uncommitted uploads are excluded. Users retain unsent drafts, but in-flight actions may need retrying. Choose a quiet window: writes stay paused for the **entire** copy and verification interval, and for deployment when updating.

This is a full copy, without incremental deduplication. Budget stored table/file/key bytes, S3 write/read requests and attachment-provider transfer costs for every recovery point. Current limits are 25 records and 2 MiB per table page, the application's 8 MiB attachment limit, and an 8 MiB manifest. Exceeding a limit fails verification; it never reports a partial copy as recoverable. A backup restores its frozen state, not later writes, browser drafts, DNS or unrelated infrastructure data.

## Configure the cloud update executor

The supplied [installation-update.yml](https://github.com/inchidev/anycord/blob/main/.github/workflows/installation-update.yml) uses GitHub-hosted Actions. Both release archives include its template and preparation script under `cloud-executor/`. Copy them to `.github/workflows/installation-update.yml` and `scripts/prepare-cloud-update.mjs` in the deployment repository's default `main` branch. Keep the application's pinned Wrangler tooling in that repository. Configure its `installation.json` for the existing Worker, D1, attachment R2 bucket and HTTPS origin, and its protected `production` environment with:

- `CLOUDFLARE_API_TOKEN`: deployment access for the intended installation.
- `MIGRATION_TOKEN`: the installation's existing migration/operator token.

In Settings, select `owner/repository`, workflow filename and a fine-grained GitHub token scoped to that repository with **Actions read/write**. The application verifies that the workflow exists and is active. Keep main protected: workflow code can access the environment's deployment credentials. Those credentials remain in GitHub; the application stores only the encrypted dispatch token. An expired/revoked Actions token must be replaced before requesting another update.

The supplied executor targets Cloudflare. A remote celld installation needs its own cloud workflow with access to the existing host/Docker context, persistent state mount and deployment secrets; copying the Cloudflare example alone will not deploy celld. Direct S3 backups work on both runtimes. A temporary Actions job is still called a runner by GitHub, but no permanently connected operator process is needed.

## Apply an update

The UI checks stable immutable releases from `inchidev/anycord`. It verifies engine, API and schema upgrade compatibility. A changed release commit after owner approval is refused. Same-schema releases are supported by default; a schema change requires an explicit compatible declaration in `release-upgrade.json`, embedded in the published manifest. API v1 alone is insufficient.

An update freezes the installation and creates/verifies a new encrypted S3 checkpoint before dispatching the cloud workflow. The workflow checks the requested origin against its checked-in installation configuration and verifies the logical installation ID, target version and checkpoint. It downloads the installed version's immutable operator package, checks its checksums and identity, then claims that approved operation.

The temporary executor downloads and verifies the recovery point, fetches the exact approved release, checks artifact hashes and archive paths, and activates the prebuilt package. It preserves the existing resources and secrets, applies authenticated `/api/_migrate` migrations and verifies the exact client/Worker version, commit and schema. Before reopening chat it compares all prior records, private files, installation identity and keys with the checkpoint. Existing sessions survive an ordinary compatible update. No `wrangler d1 migrations apply` is used. Ephemeral recovery copies and claims are removed when the job exits; the independent S3 checkpoint remains.

A definitive dispatch rejection or a cloud workflow failure **before any deployment claim** safely reopens chat. Fix the executor and request a fresh update/checkpoint. If dispatch acceptance is uncertain or deployment was claimed/interrupted, the installation stays paused. Inspect the workflow, stop any previous executor and use **Retry cloud update** to reuse the pinned checkpoint. Retry is refused while an update is running; stale workflow runs cannot fail a newly dispatched attempt. A checkpoint whose snapshot is no longer frozen cannot be claimed for deployment.

The UI observes failed Actions runs while Settings/status is being checked. It does not assume that an unresponsive workflow deployed successfully. GitHub environment approvals and queued capacity can delay a job; the write pause remains until the operation is explicitly resolved.

## Download and restore

Use the published package's standalone `operations/` CLI with Node 22. Download a copy directly from S3 even when the source installation is unavailable. Create a private configuration file with absolute paths and the **source** installation ID/bucket credentials:

```json
{
  "origin": "https://empty-target.example.com",
  "engine": "cloudflare",
  "migrationTokenFile": "/private/target/migration-token",
  "backupDirectory": "/private/recovery",
  "releaseDirectory": "/private/operator",
  "s3": {
    "endpoint": "https://<account-id>.r2.cloudflarestorage.com",
    "bucket": "anycord-backups",
    "region": "auto",
    "accessKeyId": "<backup-bucket-key>",
    "secretAccessKey": "<backup-bucket-secret>",
    "installationId": "<source-installation-id>"
  }
}
```

Supply `ANYCORD_BACKUP_KEY` from your secret manager, or add `recoveryKey` to the protected S3 config. Keep local key files separate from encrypted copies during transfer. Download writes private directories (0700) and files (0600), bounds network reads, verifies the authenticated inventory and ciphertext/plaintext hashes, and refuses unsafe paths/symlinks.

```sh
node operations/cli.mjs download /private/target/operations.json <backup-id>
node operations/cli.mjs verify /private/target/operations.json /private/recovery/<backup-id>
node operations/cli.mjs restore /private/target/operations.json /private/recovery/<backup-id>
```

Provision a **separate empty installation** with the matching schema/API and fresh Worker/DO/DB/file resources, or fresh celld state/store. The restore protocol refuses an existing populated destination. Integrity, key, columns, counts and attachment inventories are verified before any target mutation. The target retains its own fresh encryption/signing/operational keys; imported settings and app signing secrets are re-encrypted for them. Attachments are rebound under a unique destination prefix; source bytes and unrelated destination objects are never overwritten.

Accounts, IDs, password hashes, memberships, invitations, bans, recovery keys, threads/reactions, files, roles, grants and audit history survive. Sessions are revoked. Apps start disabled; Telegram login/registration/notifications and external integrations require owner review before enabling. Backup storage and cloud executor credentials are **not activated on the destination**: explicitly reconnect them. Every imported record/file is read back and foreign keys checked before maintenance ends. A mismatch leaves the destination paused for explicit recovery.

Verify sign-in, communities, threads/reactions and private download before changing routing. Keep the original installation and checkpoint available until acceptance. A code rollback is not a database restore: incompatible schema changes require the matching backup/code in a separate destination.

## Advanced manual operator

Existing format 1 filesystem backups remain readable. They are **not encrypted archives**: restrict/encrypt their volume and protect `private/secrets.json` separately. A trusted Node operator with the installation migration token can still run `run`, `once`, `backup`, `resume` and `rollback`. Keep its backup directory outside deployment state and releases. Configure Cloudflare activation with the existing installation file, pinned Wrangler path and a token environment variable, or celld activation with the existing Compose file/project/service/context and persistent volume. Never run two independent deployment controllers for one installation.

For an interrupted cloud update, a manual executor uses `runnerId` equal to the update job UUID and `backupMode: "installation-s3"`; it downloads the pinned S3 recovery point before deployment. Stop the prior cloud job first. Resume/rollback requires the original verified checkpoint and maintenance fence. Remove a stale local lock only after confirming its process is gone. Rollback verifies the original schema/API/data/files/keys and refuses a schema rollback; it never replays records over an active installation.

## Validation

`npm run verify` includes native S3 tests on real workerd/D1/SQLite Durable Objects and both API engine handlers, plus the existing manual recovery suite. Tests cover separate-bucket enforcement, owner/password checks, encrypted/authenticated payloads, transient upload failures, restart/resume, cancellation/write fencing, corrupt inventory/wrong-key refusal before target mutation, fresh restore, retained/pinned checkpoints and cloud dispatch after verification. Provider and release calls in these local tests are doubles; runtime replacement and stored records/files are real.

`npm run test:telegram-launch` exercises the built owner settings at 390/1280px: storage and executor configuration, key delivery, policy, native backup/progress/cancellation and update dispatch without an operator heartbeat. `ANYCORD_TEST_DOCKER_CONTEXT=colima npm run test:operations:docker` additionally runs real celld alarms, separate RustFS services with independent credentials, encrypted offline download/restore and actual Compose replacement. It uses only disposable test resources; ports 19980–19983 must be free. Live release promotion and a real GitHub-dispatched owner update are separate acceptance steps.

# Installation backups and updates

Backups and updates belong to the **installation**, including all communities. An ordinary community owner cannot operate on the installation. Installation Settings → Backups & updates shows the current version, runner status, policy, operations, verified checkpoints and the latest compatible immutable release. A community is not an independently updatable deployment.

This feature needs the release that introduces migration `0008_fancy_vanisher`. Earlier installations use the existing manual published-package installation procedure once to bootstrap it. Subsequent compatible releases can be selected in Settings. Publication, merging and runner startup never automatically update installations.

## Trust and operation boundary

Run one operator process per installation on a trusted machine. It holds the migration token and the deployment capabilities for that installation. The browser can request a backup/update and inspect sanitized status; it never receives Cloudflare deployment tokens, backup encryption keys, runner claims or raw account tables. The migration token grants full operator backup/restore/migration access and must be protected like the installation encryption key. Use HTTPS, or loopback for local testing. Cross-origin operator requests and redirects are refused.

The runner copies data to an operator-controlled filesystem outside the deployment. Mount backup storage outside the immediate failure boundary, for example an encrypted off-host volume. All newly created backup directories are private (0700), all payloads and key files are 0600. **The portable format is not an encrypted archive.** Account hashes, provider credentials and signing/encryption keys are sensitive even though settings are encrypted in the database. Restrict and encrypt the backup volume; do not put it in Git, a public bucket or a shared download directory. Keep `private/secrets.json` protected separately when transferring/storing copies. It is required to verify and recover encrypted settings.

No Cloudflare account token or Docker access is stored inside the application Worker. The runner uses the same operations protocol on native Cloudflare and celld. Cloudflare account actions are performed by the configured operator's deployment credentials. celld activation uses the operator's existing Docker Compose deployment and state mount.

## Runner setup

Extract a verified published package. Its `operations/` directory contains a Node.js CLI with bundled contracts; the portable backup/restore code needs Node 22 and no application rebuild. For Cloudflare activation install the release's pinned Wrangler on the operator machine. For celld activation provide Docker/Compose and the existing deployment's configuration. Run the runner under your usual service supervisor; after an interrupted update/restore use explicit recovery rather than silently restarting the operation.

Create a private configuration file with **absolute paths**:

```json
{
  "origin": "https://chat.example.com",
  "engine": "cloudflare",
  "migrationTokenFile": "/private/anycord/migration-token",
  "backupDirectory": "/mnt/encrypted-backups/anycord",
  "releaseDirectory": "/private/anycord/releases",
  "cloudflare": {
    "installationFile": "/private/anycord/installation.json",
    "wrangler": "/private/anycord/tooling/node_modules/.bin/wrangler",
    "tokenEnv": "CLOUDFLARE_API_TOKEN"
  }
}
```

The installation JSON is the existing account/Worker/D1/R2/origin configuration described in `RELEASES.md`. The adapter checks the origin and existing DB/bucket, preserves runtime variables and resource bindings, deploys the verified package, then compares bindings again. It refuses unsupported existing binding types rather than dropping them. Store the Cloudflare token in the supervisor's environment or secret manager; never in CLI arguments. `migrationTokenEnv` (default `ANYCORD_MIGRATION_TOKEN`) can replace `migrationTokenFile`.

```sh
node operations/cli.mjs run /private/anycord/operations.json
```

`run` heartbeats and polls for owner-requested jobs. `once` processes at most one queued job. `backup` queues/processes one explicit backup. One local lock and a stable runner identity live under `releaseDirectory`. A database unique index serializes active installation jobs. Claims are fenced and private; a second poller cannot claim a running job. Do not copy a runner identity to another live host or run two independent deployment controllers for one installation.

### celld with Docker Compose

Use a Compose service with `image: ${ANYCORD_IMAGE:?Choose a published Anycord image}`, the same project/service names, the same `/app/.celld` persistent volume/bind and the same AUTH_BASE_URL and S3/RustFS environment. Preserve the existing named volume; do not create a replacement project or use `down --volumes`. The packaged Dockerfile builds an image from prebuilt application assets, without rebuilding application source. The runner assigns an explicit version-and-commit image tag.

```json
{
  "origin": "https://chat.example.com",
  "engine": "celld",
  "migrationTokenFile": "/private/anycord/migration-token",
  "backupDirectory": "/mnt/encrypted-backups/anycord",
  "releaseDirectory": "/private/anycord/releases",
  "celld": {
    "composeFile": "/srv/anycord/compose.release.yml",
    "envFile": "/private/anycord/storage.env",
    "project": "celld-local-chat",
    "service": "chat",
    "context": "colima"
  }
}
```

Omit `context` when using the default Docker context. The migration token must be available to the operator in a private file/environment. celld's start script now preserves `.celld/migration-token` across restarts, alongside `.celld/app-secret`. Before any container replacement the adapter inspects the running container and resolved Compose configuration, verifies the persistent state mount and storage/auth environment, and refuses changes. It builds the prebuilt release image, recreates only the configured service, and verifies the original mount again. Back up the externally hosted S3/RustFS service operationally as well; portable backups contain committed attachment bytes but not unrelated bucket objects or provider configuration outside Anycord.

## Backup format and consistency

A backup directory is named by UUID. `manifest.json` records format 1, logical installation identity, engine, origin, exact app/API/schema/source identity, timestamp, table columns/counts and SHA-256/size inventories. `tables/*.jsonl` contains application/auth records in bounded pages. `objects/<attachment-id>` contains committed private attachments, including files in older configured stores. `private/secrets.json` contains APP_SECRET and the operational/setup keys needed for recovery. Every payload is checked before a checkpoint is recorded.

A maintenance flag stops new chat/API work. SQLite triggers reject writes to snapshot-owned tables even from requests/background work that already started. Reads are paged by rowid while the snapshot stays frozen; files are immutable committed uploads. Unfinished uploads, sessions, OAuth challenges, live tickets, active calls and pending notification deliveries are excluded. In-flight actions may fail/retry and callers retain unsent drafts; choose a quiet maintenance window. The freeze remains until all payloads, counts, keys and checksums are verified. This avoids claiming a transactionally consistent copy from a sequence of uncoordinated reads.

The first version intentionally pauses writes for the full backup/update verification interval. A large installation therefore needs a planned window. Duration, disk use and recovery point are recorded by the operator; a copy restores the state at its freeze, not subsequent changes. Provision sufficient backup disk capacity and monitor the supervised runner.

Budget retained table/file/key bytes on the operator volume plus transfer and object-read costs at the source provider. Each backup copies every committed attachment; there is no incremental deduplication. `retainBackups` limits verified local recovery points, with interrupted-update checkpoints additionally pinned. Neither retention nor the schedule controls a provider’s own object versions, database recovery window or off-site volume bill.

Owner policy sets backup interval in hours (0 disables scheduling) and a minimum retention count of 2. While connected, the runner queues a due backup only when no other job/maintenance operation is active. After reconnect it runs one overdue backup, not a burst of missed intervals. Retention removes only complete, checksum-verified directories belonging to that installation. Partial/corrupt/foreign directories and checkpoints needed by interrupted updates are preserved for operator inspection. Retention is not an off-site replication service.

```sh
node operations/cli.mjs backup /private/anycord/operations.json
node operations/cli.mjs verify /private/anycord/operations.json /mnt/encrypted-backups/anycord/<backup-id>
```

## Applying an update

Settings offers only an explicit published immutable stable version. The runner re-fetches its metadata and manifest from `inchidev/anycord`, verifies engine/API/schema compatibility, artifact SHA-256/size, safe archive paths and exact packaged client/Worker identity. A changed commit after owner approval is refused. Download/preflight failures happen before deployment. Releases with no upgrade declaration are supported only on the same schema. A different schema requires an explicit `upgrade.fromSchemas` declaration with `migrations: "backward-compatible"`; API v1 alone is insufficient. Release authors maintain `release-upgrade.json`, which is embedded in the manifest.

The runner freezes the installation, creates/verifies a complete checkpoint and pins it before activation. It deploys the exact prebuilt package, applies authenticated application migrations, and verifies health plus exact client/Worker version/commit/schema. Privileged migration batches temporarily bypass the write guard **inside the same SQLite transaction**, never exposing an unguarded interval to another writer. Before reopening chat it compares every prior application record and private object with the recovery point and proves that the installation identity and all saved keys remain unchanged. Existing sessions remain usable for an ordinary compatible update.

No `wrangler d1 migrations apply` is used. Backups are mandatory; an update cannot progress to deployment without a verified checkpoint. Jobs survive process restarts. A failed update stays in maintenance with its checkpoint and diagnostics; it is not advertised as successfully updated.

## Restore drill and recovery

Provision a **separate empty installation** with the same supported schema/API and fresh Worker/DO/DB/file resources, or an independently configured empty celld process/state/store. Engine conversion is supported by the shared logical records/file format; provision the target storage explicitly. The restore protocol checks the target installation identity and refuses existing accounts, custom communities/channels/messages or attachments. It does not overwrite a running installation.

```sh
node operations/cli.mjs restore /private/empty-target/operations.json /mnt/encrypted-backups/anycord/<backup-id>
```

All checksums, record counts, columns, attachment inventories and the source encryption key are verified **before** any target mutation. The target keeps its own fresh encryption/signing and operational keys; imported encrypted settings are re-encrypted for that key. Attachments are rebound to the destination store under a unique installation/restore prefix; source objects and unrelated destination keys are never overwritten. Messages are loaded before threads with temporary null links, then original reply/thread relationships are reattached. Every imported record and object is read back, transformed encrypted settings are verified by plaintext, and foreign keys checked before maintenance ends. A mismatch leaves the destination frozen for explicit recovery.

Accounts, IDs, password hashes, memberships, invitations, bans, recovery keys, threads/reactions and files survive. Old sessions/OAuth tokens, live tickets, calls and pending deliveries do not. Telegram login/registration/notifications are disabled initially; saved credentials remain available for owner review. AI/huddle/bot provider calls are blocked by a restore marker until the installation owner explicitly enables external integrations in Settings. Review the new domain, bot callback/webhook and auth policy before enabling Telegram again. The owner signs in with their original password/recovery mechanism and generates fresh recovery keys as needed.

Verify sign-in, community access, threads/reactions and private file download on the destination before changing any public routing. Keep the original installation and checkpoint available until acceptance. Record the measured restore time and backup timestamp. The portable snapshot does not include browser drafts, uncommitted uploads, provider-side call state, DNS or unrelated infrastructure data.

### Interrupted jobs

Stop the old runner/deployment process first. Inspect its private `last-error.log` and the installation job/health. A stale `runner.lock` is removed manually only after verifying that its PID/process is gone. Keep the same runner identity and recovery directory.

```sh
node operations/cli.mjs resume /private/anycord/operations.json <update-job-id>
node operations/cli.mjs rollback /private/anycord/operations.json <update-job-id>
ANYCORD_RESTORE_RESUME_ID=<restore-job-id> node operations/cli.mjs restore /private/empty-target/operations.json /mnt/encrypted-backups/anycord/<backup-id>
```

An update resumed after successful deployment proves the target identity, migrations, original data/files/keys and checkpoint before completing; otherwise it reuses the verified source checkpoint. Restore resumes only its own still-fenced partial destination and resets that imported data before replaying the same verified backup. Failure never unlocks a partial restore/update. A backup can be cancelled safely from Settings: fencing prevents the old runner from recording it as verified afterward.

`rollback` applies only to an interrupted update and its original verified checkpoint. It refuses a changed schema/API before activation, selects the checkpoint’s exact immutable source release, preserves the frozen database/files/keys and verifies their original contents before reopening chat. It changes code, never replays database records. If the new code/schema changed existing records, verification remains failed and maintenance stays enabled. For an incompatible schema change, restore the matching backup into a separate empty destination and promote the matching code; a code rollback is not a database rollback. Never move a published tag or treat a partially published release as stable.

## Validation

`npm run test:operations` uses real workerd/D1/DO/R2 and the actual celld API handler with an intercepted S3-compatible provider. It exercises installation-owner authorization, operation serialization/idempotency, write-trigger fencing, complete backup/key/file verification, corruption refusal before mutation and after import, interrupted restore/resume, password/membership/thread/file recovery, revoked sessions, disabled restored integrations, refused non-empty destinations, failed deployment/resume, runtime replacement, migrations and exact prior record/file/key preservation. It also checks retention of pinned/foreign/corrupt copies, compatible code rollback and refusal of schema rollback. Provider/deployment adapter tests additionally cover archive integrity/paths and wrong resource/state targets. Browser checks cover owner Settings controls and progress at mobile/desktop sizes. These checks do not claim a live Cloudflare rollout or physical mobile acceptance; promotion remains a separate explicit operation.

`ANYCORD_TEST_DOCKER_CONTEXT=colima npm run test:operations:docker` (omit the context override for default Docker) additionally uses a unique disposable Compose project, independent source/target state volumes and a real isolated RustFS service. It performs a portable backup/restore and actual prebuilt celld container replacement, then verifies old login sessions, records, private bytes and two-client realtime/writes. Only this test’s containers/volumes/images are removed afterward. Ports 19980–19982 must be free. Version fixtures are local; this does not publish a release.

Measured local drill on 2026-10-15: 176 ms backup and 385 ms restore for two accounts, two communities and one 12-byte private attachment, using Docker/Colima and real celld/RustFS. These tiny-fixture timings exclude provisioning/image builds and do not predict a larger installation’s outage or restore time. Workerd interruption tests exercise threads/reactions and provider-key re-encryption as well. The final acceptance of two actual published releases on live Cloudflare remains a separate release/promotion check.

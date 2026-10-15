# Changelog

## Unreleased

## 0.6.0 — 2026-10-15

- Back up directly from the installation to an independently configured private S3-compatible bucket, without an always-on operator. Persist bounded progress in SQLite Durable Objects and resume through alarms after a restart.
- Encrypt backup records, files and recovery secrets with AES-256-GCM; authenticate the inventory and verify every uploaded payload by readback. Deliver a separate recovery key, with password-protected export. Keep verified recent and interrupted-update checkpoints in S3.
- Update from Installation Settings through a temporary GitHub Actions executor after verifying a fresh S3 checkpoint. Keep deployment credentials in the protected deployment repository, verify exact immutable packages and prior records/files/keys, and fence interrupted deployments for explicit retry.
- Retry production verification until the deployed Worker, database schema and public client converge, including idempotent migrations during propagation.
- Include independent S3 download/decryption in the standalone recovery CLI. Fresh restores require reconnecting backup storage and the executor. Retain compatibility with existing manual filesystem copies.

### Upgrade

API v1 is unchanged. Migration `0012_separate_s3_backups` adds the recovery-point catalog. Install this release once with the published-package promotion procedure, then configure a separate backup bucket/recovery key and a repository-scoped Actions token in Settings. The supplied cloud workflow targets Cloudflare; a remote celld host needs its own executor. Writes pause for the full snapshot and update verification interval.

### Validation and limits

Native backup/restore and cloud-dispatch behavior are checked on both real workerd engine handlers, including retries, runtime restarts, cancellation, key/inventory corruption, retention and interrupted cloud jobs. Built-client settings are checked at mobile/desktop sizes. A disposable real celld/two-RustFS drill verifies independent keys, alarms, encrypted offline download/restore and Compose replacement. Local provider/release doubles do not establish a live GitHub-dispatched production update.

## 0.5.0 — 2026-10-15

- Add custom server roles, `@everyone`, multiple role assignments, hierarchy, per-channel role/member allow/deny rules and audit history. Apply permissions to discovery, messages, search, private files, realtime, notifications, AI and voice admission (#24).
- Add server apps with separate bot identities, explicit channel grants, hashed credentials, credential rotation, typed slash commands and signed outbound events with persisted retries and stable IDs. Installation owners enable apps and approve outbound origins; server owners manage their apps (#9, #25).
- Accept Slack-compatible incoming webhook `{ "text": "…" }` payloads at channel-bound secret URLs and return plain-text `ok`. Include independent URL rotation/revocation and an optional durable idempotency key. Rich Slack blocks, attachments, threads, OAuth and Discord compatibility are outside this release.
- Add whole-installation backup/restore and explicit immutable-release updates through a trusted operator runner, external recovery storage, maintenance fences, verified pre-update checkpoints and interruption recovery (#4, #5, #26).
- Preserve roles, channel overrides, bot history, app grants, webhook hashes and message receipts in recovery copies. Re-encrypt app signing secrets for a fresh restore destination; revoke sessions, omit pending deliveries and start restored apps disabled.
- Package the standalone operator runner and operations guide with both Cloudflare and celld artifacts.

### Upgrade

API v1 is retained. Apply the ordered migrations `0008_roles_permissions`, `0009_strong_spiral`, `0010_cute_blob` and `0011_fancy_vanisher`. Back up the database, private attachments and encryption/signing/operational secrets first, preserve existing resources and secrets, and use the authenticated `/api/_migrate` procedure. Migration 0008 preserves existing member chat capabilities; regenerate previously issued attachment download links. Apps start opt-in.

Existing 0.4.1 installations need one manual upgrade using the published package to bootstrap the operations protocol. Afterward, connect the trusted runner and explicitly select a compatible published release in Installation Settings → Backups & updates. Protect/encrypt external backup storage: portable recovery copies contain sensitive records and keys and are not encrypted archives. Publishing does not update production or independent installations automatically.

### Validation and limits

The combined verification suite, mobile/desktop generated-client checks, both runtime app/permissions/recovery tests, and the disposable celld/Docker/RustFS backup/restore/runtime replacement drill passed. A local workerd upgrade from the verified published 0.4.1 Cloudflare package preserved accounts, an existing session, history and private attachment bytes. Both release archives were checked for checksums, embedded identity, ordered migrations and standalone operator imports.

Role changes conservatively end active server huddles and cancel pending slash commands. Provider/device audio validation and a live Cloudflare operations-runner update between two published versions remain separate acceptance steps.

## 0.4.1 — 2026-10-15

- Join a community inside Telegram Mini App from the server picker or community menu: paste an invitation, review the community, installation and account, then explicitly accept with the current session (#22).
- Preserve direct invitation and Telegram `startapp=invite_<token>` destinations through Mini App sign-in. Reject links from a different installation before sending their token, and keep pending invitations isolated by installation.
- Unify personal and installation settings in one dialog with explicit scope, a Back action, direct owner entry, predictable close/Escape and focus/scroll handling. Keep community settings and installation-owner permissions separate.

### Upgrade

API v1 and schema `0007_cultured_toad_men` are unchanged. Back up the installation database, attachments and encryption/signing secrets, then promote the published artifacts while preserving the existing resources and secrets. Installed PWA clients receive the normal explicit update prompt.

### Validation and limits

The full verification suite and generated-client browser checks passed, including mobile/desktop settings navigation, malformed/foreign/expired/banned invitations and remote-session isolation. A disposable local Cloudflare Worker/D1 installation verifies signed Mini App login, actual Better Auth sessions, invitation use counts, private-community access, membership refresh and owner settings navigation. Telegram SDK/provider calls use local doubles. Real Telegram iOS/Android acceptance of these UX changes remains separate.

## 0.4.0 — 2026-10-15

- Add installation-wide Authentication settings, Telegram OIDC and Mini App sign-in, explicit account linking and password fallback for Telegram-created accounts.
- Add encrypted bot/OIDC configuration and setup instructions under Installation Settings → Integrations; keep server invitations and recovery keys independent.
- Add opt-in Telegram notifications for mentions, replies and followed threads, channel muting, verified bot consent and bounded delivery retries.
- Respect Telegram's live device/content safe areas and viewport in chat, server selection and dialogs. Open the Mini App on a compact server directory after session resolution, without briefly showing the login form.
- Use verified Telegram names and avatars across the server picker, profiles, members and messages without displaying Telegram IDs; preserve internal handles and existing password-account names. Match the Mini App safe-area and native top-bar colours to the active header.
- Add manually triggered PR previews restricted to GitHub Maintain/Admin, with isolated Worker, D1, R2 and Durable Object resources (#17, #19).
- Add migration `0007_cultured_toad_men` for Telegram preferences/outbox, thread follows and unique Telegram account bindings. API v1 remains compatible; existing installations keep password login and open registration by default.

### Upgrade

Back up the installation database, attachments and encryption/signing secrets before upgrading. Preserve existing resource bindings and secrets, apply migration `0007_cultured_toad_men` through the authenticated `/api/_migrate` endpoint, then verify client/Worker version and schema. Password login remains available by default; owners configure Telegram credentials and login methods explicitly. Publishing this release does not automatically update production or tenant installations.

### Validation and limits

The full verification suite and generated-client browser regression tests passed. Telegram Web launch, profile photos, session persistence and header colours were verified on the isolated preview; the user accepted the Mini App flow and visual changes on iOS. Browser OIDC, Android and live notification delivery still need acceptance with a dedicated test bot. Local provider tests cover signature/claim failures, profile matching, account linking and notification authorization/retries without proving live delivery.

## 0.3.0 — 2026-10-15

- Add server invitations with expiry, use limits and revocation, plus member removal, bans and unbanning (#12).
- Add password confirmation and eight recovery keys shown once. Password recovery preserves account identity and memberships while revoking old sessions and keys (#12).
- Separate installation settings from community settings; add microphone/output selection and mute controls for huddles (#12).
- Improve mobile keyboard positioning, safe-area backgrounds and touch focus behavior (#13 and the preceding viewport fix).
- Add an installable PWA, an offline public app shell, explicit updates that preserve drafts, offline-send rejection and draft cleanup on logout (#14).
- Publish immutable Cloudflare and celld packages with checksums and app/API/schema/source identity. Separate PR merges, release publication and production promotion (#14).
- Keep cold SPA routes working for login, server selection, invitations and recovery.

### Upgrade

This release adds database migration `0006_cynical_jetstream` for invitations, recovery keys and server bans. Back up the installation database, attachment objects and encryption/signing secrets before upgrading. Keep existing secrets and resource bindings. Apply application migrations through the authenticated `/api/_migrate` procedure, then verify the exact client/Worker release and persisted data.

API v1 is retained. Existing accounts and messages remain in place. Recovery keys become available after the owner/user generates them in account settings. Notification delivery and native mobile applications remain future work.

### Validation and limits

The combined release is checked with the full verification suite, the disposable celld integration suite, package integrity checks and production release identity/data checks. Real iOS/Home Screen and Android installation/keyboard behavior and live audio between real devices still require device testing. Local provider doubles are used for paid AI and RealtimeKit integration scenarios.

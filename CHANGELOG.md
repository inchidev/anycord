# Changelog

## Unreleased

- Add installation-owner backup policy/status and a trusted operator runner for whole-installation D1/auth data, committed R2/S3 files and protected recovery keys (#4).
- Verify portable recovery points before restore into a separate empty installation; preserve accounts/communities/threads/files, revoke sessions and disable external integrations until owner review.
- Add explicit immutable-release updates with a verified pre-update checkpoint, serialized/fenced jobs, maintenance, authenticated migrations, resource/key preservation, progress and explicit interruption recovery (#5).
- Package the runner and operations guide for Cloudflare and celld. Existing installations bootstrap migration `0011_fancy_vanisher` with a manual published-package upgrade once; subsequent compatible releases can be selected in Settings. No deployment or automatic update occurs on merge.

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

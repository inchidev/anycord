# Changelog

## Unreleased

- Add installation-wide Authentication settings, Telegram OIDC and Mini App sign-in, explicit account linking and password fallback for Telegram-created accounts.
- Add encrypted bot/OIDC configuration and setup instructions under Installation Settings → Integrations; keep server invitations and recovery keys independent.
- Add opt-in Telegram notifications for mentions, replies and followed threads, channel muting, verified bot consent and bounded delivery retries.
- Add migration `0007_cultured_toad_men` for Telegram preferences/outbox, thread follows and unique Telegram account bindings. API v1 remains compatible; existing installations keep password login and open registration by default.
- Validate browser OIDC and native Telegram Mini App behavior with a dedicated bot before deployment. The local Telegram provider tests do not establish live Telegram/device acceptance.

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

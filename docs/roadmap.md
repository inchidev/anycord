# Community access roadmap

## Current milestone

- Only the installation owner can create new servers. Community ownership alone does not grant this installation-level permission.
- Server-scoped invite links with expiration, usage limits and owner revocation.
- Username/password registration with client-side password confirmation.
- Eight recovery keys, generated after verifying the current password. Only hashes are stored. A successful reset preserves the account and memberships, changes the password, revokes all prior sessions and invalidates the entire old key set. Generate a fresh set after signing in again.
- Server owners can remove members, ban them from joining again and remove bans. The server owner cannot be removed. Existing realtime connections and active huddle participants are disconnected during removal.
- Installation Settings belongs to the installation owner: RealtimeKit/OpenRouter credentials, file storage and database details. Server Settings belongs to each community: identity, channels, invitations and members.
- Whole-installation backup/restore and explicit release updates use a trusted operator runner, external recovery storage and a maintenance window. See [operations](operations.md) for setup, protection, compatibility, interruption recovery and validation limits.
- Voice huddles use the installation's configured RealtimeKit app and participant preset. The huddle includes microphone selection, output selection where supported by the browser, and mute/unmute. Provider tests use a local double; two-device live audio still needs actual credentials and browser permission checks.

## Roles and channel permissions

Custom server roles, @everyone, multiple roles per member, position-based management hierarchy and explicit string permission keys are implemented together with per-channel role/member allow/deny overrides. Server Settings includes role editing, member assignments, channel permissions and audit history. HTTP, realtime, search, private files, voice admission and notifications enforce the same permission model. Installation ownership remains separate.

See [roles and permissions](permissions.md) for precedence, extension points, migration behavior, validation and the initial conservative huddle-revocation policy. GitHub/repository scopes and agent delegation build on this foundation later. Installation upgrades follow the explicit versioned release procedures.

## Decisions still open

- Further installation administration: account administration, installation name and per-community export/import. Authentication policy and whole-installation backup/status/update operations are implemented.
- Shared login across independent installations, federation and background notifications from multiple connections. An installation admin panel alone does not implement these capabilities. Keep identities and credentials independent until a protocol and trust model are chosen.
- Stronger shared-D1 tenant isolation and a possible control database plus per-server databases: [issue #1](https://github.com/inchidev/anycord/issues/1).

## Current boundaries

The initial `main` server still accepts newly registered local accounts. Other servers require membership through invitation or creation. A removed member may rejoin using another valid invitation; a banned member cannot until unbanned. Removing a ban does not automatically restore membership. A ban applies to the account on that server, not to other installations or newly created identities.

Invitations are generated as `/invite#token=…` links, so the secret is not part of the page's HTTP URL. The client temporarily saves a pending token in session storage across sign-in and clears it on acceptance. Invitation tokens and recovery keys are never returned by listing/status endpoints. Copy a newly created invitation immediately; its secret cannot be retrieved later.

### Server apps first milestone (#9)

Server owners can install scoped incoming webhooks, including channel-bound Slack-compatible text/ok URLs and the sample Ping bot, configure identities/channel grants, register validated slash commands, rotate credentials, disable or uninstall apps, and inspect audit/delivery status. Installation owners enable third-party apps and approve outbound origins. Signed message/command events use persistent retry leases and stable IDs; receiver examples demonstrate durable deduplication. See [apps](apps.md). Richer bot APIs, deferred command callbacks and Discord API compatibility are outside this milestone.

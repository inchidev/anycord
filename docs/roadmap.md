# Community access roadmap

## Current milestone

- Only the installation owner can create new servers. Community ownership alone does not grant this installation-level permission.
- Server-scoped invite links with expiration, usage limits and owner revocation.
- Telegram Mini App invitation links and a Share in Telegram action, with a separate web link fallback. Uses the destination installation's configured bot when Mini App login is enabled.
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

Web invitations use `/invite#token=…`, so the secret is not part of the page's HTTP URL. When Mini App login is enabled, the primary invitation is `https://t.me/<installation-bot>?startapp=invite_<token>`; the web alternative remains available. Telegram links require the bot's Main Mini App to point at that installation. Sharing opens Telegram's chat chooser with the invitation; the user chooses the recipient and sends it. Telegram necessarily receives the invitation capability in this flow. The client temporarily saves a pending token in session storage across sign-in and clears it on acceptance. Neither link bypasses registration policy, bans, expiration, usage limits or explicit join confirmation. Invitation tokens and recovery keys are never returned by listing/status endpoints. Copy a newly created invitation immediately; its secret cannot be retrieved later.

## Planned: Telegram group connections

This is roadmap work, not implemented group membership or notification behavior.

- Start with one Telegram group explicitly connected to one existing Anycord server. Store the destination installation, server and starting channel in the binding. A group administrator confirms the Telegram side; the Anycord server owner authorizes the connection. Adding a bot alone never creates a server or grants installation ownership. New-server provisioning remains subject to installation-owner policy.
- Group members have a right to enter the connected server without individual invitations. Verify signed Telegram identity and current group membership at first access, then create or reuse the local account and materialize membership. There is no full participant-list import through Bot API; the Anycord member list initially includes people who have opened the app.
- Require a bot administrator for reliable membership checks and subscribe to membership updates. Recheck membership on access with a defined freshness policy; fail closed when membership cannot be verified. Leaving/removal revokes access derived from this binding and active sessions/voice admission to that scope; separately granted membership can remain. Anycord bans take precedence. Telegram administration does not automatically confer Anycord server ownership or access to private channels.
- Provide a persistent Open chat button in the group. Group announcements are selected by its administrator; personal replies, mentions and followed-thread alerts require the user's own notification consent and bot messaging permission. Removing the bot disables the group-derived access path and group deliveries until reconnection.
- First validation: connect one test group to an existing server; exercise existing/new members, removal, ban, bot removal, correct installation routing and opt-in notifications. Decide multi-group visibility and self-service hosting/provisioning separately.

## Planned: OpenRivers integration and product boundaries

- Anycord owns channels, messages, threads and voice. OpenRivers owns rivers, plans, events, availability, whereabouts, invitations to activities and RSVP. Planning features shown inside Anycord should embed or invoke OpenRivers using its existing data and actions, rather than create a competing planning model.
- Connect a river explicitly to an Anycord installation/server and optionally a Telegram group. Keep runtime, data, accounts and lifecycle ownership explicit; shared Telegram identity alone is not cross-installation login or a blanket permission grant. Define scoped launch/authentication and revocation before implementation.
- Begin with one OpenRivers plan linked to one Anycord discussion thread, with navigation in both directions and Telegram cards opening the appropriate destination. Activity participation does not automatically expose every channel or a person's private schedule.
- OpenRivers produces plan/RSVP/reminder notifications; Anycord produces discussion notifications. Select a delivery route and deduplicate shared events so the same activity is not announced by both integrations. Bot webhook ownership and routing must be explicit if both products share a bot.
- Validate with one river and one server before generalizing the integration. Telegram group connection, membership mapping and notification consent must remain usable for standalone Anycord.

## Server apps first milestone (#9)

Server owners can install scoped incoming webhooks, including channel-bound Slack-compatible text/ok URLs and the sample Ping bot, configure identities/channel grants, register validated slash commands, rotate credentials, disable or uninstall apps, and inspect audit/delivery status. Installation owners enable third-party apps and approve outbound origins. Signed message/command events use persistent retry leases and stable IDs; receiver examples demonstrate durable deduplication. See [apps](apps.md). Richer bot APIs, deferred command callbacks and Discord API compatibility are outside this milestone.

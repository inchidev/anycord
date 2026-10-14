# Community access roadmap

## Current milestone

- Only the installation owner can create new servers. Community ownership alone does not grant this installation-level permission.
- Server-scoped invite links with expiration, usage limits and owner revocation.
- Username/password registration with client-side password confirmation.
- Eight recovery keys, generated after verifying the current password. Only hashes are stored. A successful reset preserves the account and memberships, changes the password, revokes all prior sessions and invalidates the entire old key set. Generate a fresh set after signing in again.
- Server owners can remove members, ban them from joining again and remove bans. The server owner cannot be removed. Existing realtime connections and active huddle participants are disconnected during removal.
- Installation Settings belongs to the installation owner: RealtimeKit/OpenRouter credentials, file storage and database details. Server Settings belongs to each community: identity, channels, invitations and members.
- Voice huddles use the installation's configured RealtimeKit app and participant preset. The huddle includes microphone selection, output selection where supported by the browser, and mute/unmute. Provider tests use a local double; two-device live audio still needs actual credentials and browser permission checks.

## Next: Discord-style roles and channel permissions

Introduce server-owned custom roles, an everyone role, multiple roles per member, role ordering and named permission bits. Start with managing channels, inviting members, moderating messages, removing/banning members and joining/speaking in voice channels. Then add per-channel overrides with documented precedence. The server owner retains control; role management must not allow granting permissions above one's own authority. UI and every HTTP/realtime/media authorization path must use the same effective-permission evaluator.

Existing installation ownership must stay separate from community roles. A community role must not grant access to installation secrets or unrelated servers. Do not implement disconnected UI-only roles.

## Decisions still open

- Installation administration beyond service settings: registration policy, account administration, installation name, operational status and backup/export tooling.
- Shared login across independent installations, federation and background notifications from multiple connections. An installation admin panel alone does not implement these capabilities. Keep identities and credentials independent until a protocol and trust model are chosen.
- Stronger shared-D1 tenant isolation and a possible control database plus per-server databases: [issue #1](https://github.com/inchidev/anycord/issues/1).

## Current boundaries

The initial `main` server still accepts newly registered local accounts. Other servers require membership through invitation or creation. A removed member may rejoin using another valid invitation; a banned member cannot until unbanned. Removing a ban does not automatically restore membership. A ban applies to the account on that server, not to other installations or newly created identities.

Invitations are generated as `/invite#token=…` links, so the secret is not part of the page's HTTP URL. The client temporarily saves a pending token in session storage across sign-in and clears it on acceptance. Invitation tokens and recovery keys are never returned by listing/status endpoints. Copy a newly created invitation immediately; its secret cannot be retrieved later.

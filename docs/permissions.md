# Roles and permissions

Server Settings → Roles creates custom roles with a name, color, position and explicit permissions. Members can hold several roles; Server Settings → Members assigns them. Every member also receives the server's `@everyone` role. Server ownership remains on the membership and cannot be assigned through the role editor. Installation ownership is separate and still controls installation credentials, authentication, storage and server creation.

Permissions are registered string keys in `shared/permissions.ts`. Each definition has a label, description and supported scopes. The current scopes are server and channel. New integration modules must add their definitions and backend enforcement before exposing a key. Unknown keys are rejected by mutation contracts and never grant access. There are no wildcard grants or general administrator permission. The server owner retains all registered server/channel capabilities; ordinary roles receive new capabilities only through explicit assignment. Migration 0008 preserves existing member chat capabilities through explicit `@everyone` grants.

## Evaluation and hierarchy

1. Union the grants of `@everyone` and all assigned roles.
2. Apply channel overrides for `@everyone`: deny, then allow.
3. Combine matching role overrides: deny, then allow. An allow from one role wins a deny from another role at this step.
4. Apply member overrides: deny, then allow.

Viewing a channel is a prerequisite for its actions. Reading messages is additionally required for history, search, threads, reactions, AI context, sending messages and downloading files. Sending, uploading, creating threads, managing others' messages and joining/speaking in voice have separate checks. A member can delete their own visible messages; editing also requires Send messages.

Role position controls management authority, not override precedence. Equal positions are peers. A delegated role manager can manage only lower roles and lower members, cannot modify their own assignments, and cannot grant or remove permissions outside their authority. Managing or assigning a role also checks its channel overrides, so a server-wide role grant cannot delegate private-channel capabilities the actor does not hold. Only the owner edits the server-wide `@everyone` role. Channel permission managers can override lower roles, including `@everyone`, and lower members, using permissions they hold in that channel. Removing a role also removes its assignments and channel overrides. Leaving/removal removes member-specific overrides so rejoining cannot revive an old grant.

## Enforcement and revocation

HTTP, discovery/bootstrap, search, files, realtime delivery, typing, notification delivery and voice admission use current server/channel access. Role and override changes and member removal share the server Hub's serialized queue. Channel payload delivery is serialized with those changes and checks recipients' current permissions. Audit records are committed with role/override changes and the latest 100 are available under Server Settings → Audit log.

Clients clear private query data and refetch grants on permission events and reconnect. Attachment download grants include the requesting user in their signature, and content delivery rechecks that user's current channel permissions. Previously issued URLs stop working after access is revoked. URLs remain temporary bearer links; downloaded data cannot be recalled.

For this first implementation, updates/deletion/assignment of roles and channel overrides end **all active huddles in that server before committing the change**. Creating an unassigned role does not end huddles. If provider removal fails, policy remains unchanged and the mutation reports failure; participants already removed can rejoin under the existing policy. This conservative behavior avoids leaving active media tokens with obsolete access. The installation's optional listener preset must deny audio production and participant permission changes; without a valid listener preset, users who lack `voice.speak` cannot join a listen-only huddle. Provider calls are tested with local doubles; live audio requires separate provider/device validation.

Authorization is checked when an HTTP operation begins; an already-running request may finish under its checked access. Realtime emissions recheck access when delivered. This does not introduce a cross-service transactional revocation protocol for in-flight AI/provider requests.

## Validation

`npm run verify` includes contract/evaluator checks, role integration tests against local workerd/D1/R2/SQLite Durable Objects, and Telegram notification revocation checks. The celld integration harness additionally exercises the same role scenarios and real S3-compatible file operations in disposable application stores. Its `STORAGE_ENV_FILE` option selects the local storage test configuration; it mounts this checkout's runtime, contracts, migrations and scripts rather than testing a stale image bundle.

GitHub installations, repository scopes, agent identities/delegation and deployment permissions remain future modules. No GitHub or agent permission keys are exposed before their operations exist.

# Anycord API contract v1

Decision: 2026-10-14. Serve the generated Nuxt client and the application API from one origin. There is **no separate Nitro application server**. Each installation chooses one backend: celld, Cloudflare, TrailBase, or PocketBase.

`shared/api.ts` is the executable HTTP contract: endpoint names, methods, paths, request/query schemas and successful response schemas. `shared/contracts.ts` defines public records and realtime events. `shared/client.ts` validates inputs before transport and responses before exposing them to Vue. These files contain no database driver, platform bindings, native engine SDK or UI framework dependency. Internal database records are not public response types.

## HTTP surface

| Endpoint name | Method and path | Behavior |
| --- | --- | --- |
| runtime | GET `/api/runtime` | Contract version, actual engine, auth owner and realtime transport; no credentials |
| authStatus | GET `/api/auth/status` | Initialization status and current application user or null |
| authRegister / authLogin | POST `/api/auth/register`, `/api/auth/login` | Username/password; returns application profile and sets Better Auth cookie |
| authLogout | POST `/api/auth/logout` | Revokes session, clears cookie, closes that session's live connections; `{ success: true }` |
| bootstrap | GET `/api/bootstrap?workspace=…` | Accessible servers, selected server's channels and members |
| workspaceCreate | POST `/api/workspaces` | Installation-owner-only; create a server, owner membership and initial text channel atomically |
| channelCreate | POST `/api/workspaces/:workspaceId/channels` | Server-owner-only channel creation |
| messages | GET `/api/channels/:channelId/messages?focus=…` | Latest 100 messages or a neighborhood around a search result, sorted chronologically |
| messageCreate | POST `/api/channels/:channelId/messages` | Persist a client-generated UUID and text; acknowledge a retry without duplicating its notification |
| messageEdit / messageDelete | PATCH / DELETE `/api/channels/:channelId/messages/:messageId` | Author-only edit; author or server owner may delete |
| reactionToggle | POST `/api/channels/:channelId/messages/:messageId` | Toggle one supported reaction for the authenticated user |
| search | GET `/api/search?workspace=…&q=…` | Up to 40 results from channels within an accessible server |
| aiAsk | POST `/api/channels/:channelId/ai` | Explicit AI request and persisted response |
| huddleJoin | POST `/api/channels/:channelId/huddle` | Server-authorized join; participant token, participant ID and meeting ID |
| huddleLeave | DELETE `/api/channels/:channelId/huddle/:participantId` | Only remove the caller's participant |
| integrations / integrationsUpdate | GET / PUT `/api/integrations` | Masked settings; installation owner alone can change credentials |
| integrationsTest | POST `/api/integrations/test` | Owner-only RealtimeKit credentials/preset check |
| database | GET `/api/database` | Owner-only storage/migration information, with engine-specific descriptions |

Registration and newly inserted messages return 201; duplicate message acknowledgments return 200. Creation of servers/channels returns 201. Other successful JSON requests currently return 200. App errors have `{ message: string }` and an appropriate non-2xx HTTP status: 400 invalid input, 401 unauthenticated, 403 forbidden, 404 missing/inaccessible record, 409 conflict or missing integration, 413 body limit, 415 wrong content type, 429 rate limit, 502 provider failure, 500 unexpected server failure. Error text is human-readable and is not a stable machine error code.

Public timestamps are integer Unix milliseconds. IDs are opaque strings: existing seeded IDs and migrated IDs must survive; only newly submitted message retry IDs are required to be UUIDs. New adapters must map backend-native IDs without forcing changes throughout Vue. Responses may contain additional fields; schema parsing strips them. Missing/incompatible required fields produce an explicit client ContractError without including raw response data in that error.

`GET /api/health`, `GET /api/_runtime` and token-protected `POST /api/_migrate` are operational routes outside the app contract. Better Auth native compatibility endpoints also stay outside the app contract; frontend no longer imports the Better Auth SDK. Raw email signup remains blocked. Email recovery, custom roles and cursor pagination remain planned; recovery keys, invitations and member removal/bans are additive v1 endpoints described below.

## Identity and authorization

Better Auth owns account IDs, password verification, HttpOnly session cookies and session revocation on every engine. The browser sends same-origin cookies and never supplies a trusted user ID, role or membership. The selected backend resolves the session and authorizes every operation and realtime connection. Same-origin/CSRF checks remain enforced. Profiles map to the stable Better Auth identity. Native TrailBase/PocketBase auth does not automatically validate these cookies.

Installation ownership and per-server membership roles remain distinct. A valid session cannot read/search a private server or join its realtime channel without membership. Native engine record APIs and subscriptions must not bypass these checks. Credential values stay encrypted server-side; only masked configuration reaches the browser. Blank/omitted credential fields retain the saved key; explicit empty values remove it.

Retrying message creation with the same ID must not create a second row or event. IDs owned by another author/channel conflict. A successful write is durable before its event is published. An event failure must not falsely report that the acknowledged database write failed. Reconnect reloads history; v1 does not promise durable event replay or exactly-once delivery to a disconnected client.

## Realtime surface

Current transport: authenticated WebSocket at `/api/workspaces/:workspaceId/ws`, same public origin. `livePath()` builds its URL. An adapter must authorize before upgrade, retain a server-derived session identity, constrain typing to that server's channels, account for multiple tabs and close connections when the session is revoked. Session expiry/revocation uses close code 4001.

Server events are `ready`, `message`, `refresh`, `presence`, and `typing`, validated by `liveEventSchema`. The only accepted client event is `typing` with a channel ID, validated by `liveClientEventSchema`; user/name/role are server-derived. No members, presence, conversations or unread counts are fabricated. Member removal and its connection invalidation remain future work alongside membership management.

PocketBase native realtime and TrailBase record subscriptions are not directly interchangeable with this transport. An adapter needs a bridge for the same authorization/events. Any future transport negotiation is a contract change, not a frontend import of a native SDK.

## Adapter and deployment status

| Engine | Implementation now | Deployment |
| --- | --- | --- |
| celld | `worker/index.ts` selects shared D1 handler in `worker/router.ts`; reference implementation | Existing self-hosted Docker application, persistent volume retained |
| Cloudflare | `worker/cloudflare.ts` selects the same handler; separately bundled | Requires actual Cloudflare D1/DO/assets bindings and secrets; not provisioned or live-tested |
| TrailBase | Contract target; no application adapter yet | Native server/WASM route mechanism confirmed; embedded Better Auth needs runtime/SQL-adapter spike |
| PocketBase | Contract target; no application adapter yet | Native Go router plus private Better Auth process is the practical researched option; not implemented |

See `ENGINE_RESEARCH.md` for official sources and feasibility limits. A contract declaration or compiled entrypoint is not evidence that an engine's deployment/auth/runtime works. The local Wrangler configuration still names the existing celld development resources; it is not a production Cloudflare configuration.

## Validation and next implementation

`npm run test:contract` verifies schema/client behavior. The disposable celld integration suite parses real successful HTTP responses and WebSocket events through this contract and checks authorization, writes, retry behavior, search, restart persistence and logout revocation. It creates no accounts in the existing application database. A separately built Cloudflare entrypoint can be checked on the local D1-compatible runtime, but that remains local compatibility evidence.

Next implement a disposable TrailBase auth/runtime spike as described in `ENGINE_RESEARCH.md`, then bring its application routes under this contract and run the same behavioral scenarios. Do not add a hypothetical universal SQL abstraction or claim compatibility from matching TypeScript types. PocketBase's auth-process choice must stay explicit; requiring one process/binary would require a larger runtime integration project.

## Conversation actions — 2026-10-14

Message results now include nullable `replyToId`, `reply`, `threadId` and `thread`. Reply previews resolve server-side within the same channel/conversation. Deleted originals leave an unavailable-reference preview; existing idempotent retries still acknowledge their saved reply. Message creation accepts optional reply/thread IDs and rejects cross-channel or cross-conversation references. Thread messages stay out of the main channel history; `messages?threadId=…` reads that scope after validating the thread. Search results carry nullable `threadId` for navigation.

New endpoints are `threads` (GET `/api/channels/:channelId/threads`), `threadCreate` (POST same path), and `thread` (GET `/api/channels/:channelId/threads/:threadId?focus=…`). A channel root message has at most one thread; repeated/concurrent creations return that thread. Threads retain their messages when the root message is deleted, with a null parent. Root/channel authorization applies before thread access. Current histories return up to 100 messages; thread lists up to 100 threads. Archiving, renaming and thread-specific permissions are future features.

Reactions accept one Unicode emoji grapheme (including supported ZWJ/skin-tone/flag/keycap sequences), rather than four hardcoded choices. Quoting stores ordinary message text with `> ` prefixes; Vue renders it as text/blockquote without executing message HTML. Realtime typing may include a thread ID, validated against its channel. The contract is still pre-release v1; clients and selected adapters must ship the expanded response schemas together.

## Client collection implementation — 2026-10-14

TanStack DB Query Collections now project channel/thread message responses from the existing Vue Query cache. HTTP paths, events and backend obligations are unchanged. Query keys include account and workspace as well as conversation/focus; response fetches capture their scope before starting. A complete `message` event appends to an already-loaded latest window, deduplicating by ID. Focused windows are not expanded, and latest windows retain the current 100-message bound. Reconnect, generic `refresh` and periodic reconciliation still fetch authoritative snapshots. This remains snapshot reconciliation without durable event replay, cursor pagination or a general sync engine. Thread summaries/counts remain server-authoritative. No native TrailBase/PocketBase subscriptions or auth adapters were introduced.

## Editable server and channel settings (v1 additive endpoints)

- `workspaceUpdate`: `PATCH /api/workspaces/:workspaceId` with `{ name, initials }`; returns the updated workspace with the caller's server role. Name is 2–50 trimmed characters, icon text 1–4. Requires ownership of that workspace.
- `channelUpdate`: `PATCH /api/channels/:channelId` with `{ name, topic }`; returns the updated channel. Uses existing channel-name/topic validation and preserves channel ID, workspace, kind and position. Requires ownership of the channel's workspace.

These operations publish existing `refresh` events. Installation-owner status does not substitute for workspace membership/ownership. All backend adapters must preserve these checks and response shapes. Implemented by the shared celld/Cloudflare D1 handler; no schema migration was required. Icon text is the existing server-rail abbreviation, not an uploaded image.


## Files and independent client connections

The shared JSON registry now includes storage status/update/test, attachment creation/deletion/download metadata, explicit remote login and WebSocket tickets. Uploaded bytes travel via `PUT /api/attachments/:attachmentId/upload` with `application/octet-stream`, bounded to 8 MiB, returning the shared attachmentSchema. Signed `GET /api/attachments/:attachmentId/content?expires=...&signature=...` is a capability URL issued only after a channel-membership check; it is not a persistent public object URL. `messageCreate` accepts optional unique attachmentIds (max4) and permits empty text only with files; retries require the same attachment identities as well as text/context. File ownership and message linking are atomic. Sniffed image MIME is server-owned.

Remote clients use `connectionLogin` instead of browser cookies. `authStatus` is credentialless-readable cross-origin to drive the login screen; ambient cookies are stripped from foreign requests. Other foreign requests require the signed Better Auth bearer token. A ticket minted for an authenticated workspace is valid30seconds, single use, and bound to the requesting origin/workspace; the session is validated again on WebSocket upgrade. The query-client, API transport and drafts must stay bound to one origin. These behaviors belong to the engine contract, with native persistence/storage implementations supplied by each engine.

## Integration diagnostics

`integrationsAiTest`: POST `/api/integrations/ai/test`, owner-only, returns `{ ok: true }` after a short completion using the encrypted saved OpenRouter key and saved model. It sends only a fixed diagnostic prompt (maximum 32 output tokens), never chat history, and does not create a chat message. Missing configuration returns 409; provider rejection/invalid response returns a sanitized 502. The provider may bill the small completion. The existing `integrationsTest` endpoint continues to check RealtimeKit credentials and preset. Both adapters share this behavior.

## Release identity

`GET /api/runtime` may additionally include `build: { version, commit, apiVersion, schema }`. Both shipped adapters include it; the optional field preserves API v1 compatibility with existing clients/adapters. `/api/health` includes the same build identity alongside the applied database schema. Public `/version.json` identifies the generated client. Release verification requires all three to agree. Clients check the runtime API version before mutations/uploads and refuse incompatible backends.

## Community access and recovery — 2026-10-15

- `invites` / `inviteCreate`: GET / POST `/api/workspaces/:workspaceId/invites`. Owner-only; creation accepts `expiresInHours` (1–720, default 168) and `maxUses` (1–1000, default 25), returns 201 with a secret token shown once. Lists contain only IDs, timestamps and usage counts. `inviteRevoke` deletes only an invitation in the authorized workspace.
- `invitePreview`: POST `/api/invitations/preview` with `{ token }`, publicly returns only the invited server name/initials while valid. `inviteAccept`: POST `/api/invitations/accept` with `{ token }`, authenticated; returns `{ workspaceId }`. New membership and usage consumption are atomic; existing members do not consume another use. Invalid/expired/exhausted/revoked links return 410. A server ban prevents acceptance.
- `memberRemove`: DELETE `/api/workspaces/:workspaceId/members/:userId`; `memberBan`: POST `/api/workspaces/:workspaceId/bans/:userId`; `bans`: GET `/api/workspaces/:workspaceId/bans`; `memberUnban`: DELETE `/api/workspaces/:workspaceId/bans/:userId`. Server-owner-only. The owner cannot be removed/banned. Removal stops current provider participants before deleting membership and disconnecting realtime. If provider removal fails, membership remains and the API reports failure. Unbanning does not restore membership.
- `recoveryStatus`: GET `/api/account/recovery`, authenticated, returns `{ count, generatedAt }` for the caller, without keys/hashes. `recoveryGenerate`: POST same path with current `{ password }`; returns eight random keys and replaces all previous keys. SHA-256 hashes alone are persisted.
- `recoveryReset`: POST `/api/recovery/reset` with `{ name, recoveryKey, password }`; rate-limited and available without a session. An atomic batch claims the key, updates the Better Auth credential password, deletes current/legacy sessions and deletes the whole key set. Realtime sockets are closed; identity, profile, memberships and messages remain. Incorrect keys or usernames return the same generic 400. The user signs in again and generates a fresh set. Realtime closure is best effort if a Hub is unavailable; revoked sessions cannot reconnect.

Registration and recovery forms confirm the new password client-side. The confirmation field is not part of the wire credentials and is stripped before transport. Keys are installation-specific; recovery is performed at that installation's origin.

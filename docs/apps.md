# Server apps, bots and webhooks

Anycord has its own API; it does not implement the Discord API. Apps belong to one server on one installation. Cloudflare and celld use the same contract, migrations and outbox. Existing OpenRouter and RealtimeKit installation settings remain separate.

## Install and permissions

1. The **installation owner** enables apps in User Settings → Installation Settings → Integrations → Server apps. The default is disabled. The owner also approves exact HTTPS **origins** allowed to receive outbound events, such as `https://hooks.example.com`.
2. A **server owner** opens Server Settings → Apps & integrations, chooses Ping or an incoming webhook/external bot, names the bot and grants text channels. Optional avatars use public HTTPS URLs.
3. Review the permission summary and install. Save the app token and event signing secret immediately; they are only returned at installation and rotation.
4. Configure, disable, enable, rotate or uninstall from the same screen. Recent audit activity and delivery statuses appear below the apps.

A channel grant permits posting in that channel. Adding `message.created` explicitly grants the endpoint access to **new human messages**, including messages in threads of the granted channel. Commands share only the command name, validated arguments and invoking member ID. Apps have no human login, memberships, history/search/download API, member administration or general-purpose impersonation. Name, avatar and BOT marker are controlled by the installed app profile, not by webhook payloads. Bot posts produce neither outbound app events nor Telegram notification alerts in this milestone. Existing bot messages remain identifiable after uninstall.

The installation owner controls which external origins are trusted. Deploy receivers on public domains; IP literals, local domain suffixes, HTTP, URL credentials, explicit ports and fragments are rejected. Redirects are not followed. Origin approval is a trust decision: self-hosters should also restrict container egress/DNS if they require a network boundary against domains resolving to internal addresses.

## Incoming webhook / CI update

```http
POST /api/apps/APP_ID/messages
Authorization: Bearer ac_app_...
Content-Type: application/json

{"id":"c4477b31-7fbb-4a77-94e2-7191754d5831","channelId":"general","text":"Build passed"}
```

`id` is a client-generated UUID, stable across retries. `channelId` must be an authorized text channel on this app's server; it is not a channel name. Text has a 4,000-character limit. No attachments, replies, thread targeting or overriding the bot identity are accepted. The response uses the normal message shape, with human reaction/thread metadata omitted (`201` on insertion, `200` for the same request again). Reusing an ID with another payload returns `409`. Durable receipts prevent a deleted message being resurrected by a retry; retrying its ID returns `409`.

Use [the CI example](../examples/apps/ci-webhook.mjs) from the checkout:

```sh
ANYCORD_URL=https://chat.example.com \
ANYCORD_APP_ID=APP_ID ANYCORD_APP_TOKEN=ac_app_... \
ANYCORD_CHANNEL_ID=general ANYCORD_DELIVERY_ID=unique-build-attempt \
CI_JOB_STATUS=success node examples/apps/ci-webhook.mjs
```

For GitHub Actions, store the URL, app ID, token and channel ID as repository secrets and add a step after your build:

```yaml
- name: Announce build
  if: always()
  env:
    ANYCORD_URL: ${{ secrets.ANYCORD_URL }}
    ANYCORD_APP_ID: ${{ secrets.ANYCORD_APP_ID }}
    ANYCORD_APP_TOKEN: ${{ secrets.ANYCORD_APP_TOKEN }}
    ANYCORD_CHANNEL_ID: ${{ secrets.ANYCORD_CHANNEL_ID }}
    ANYCORD_DELIVERY_ID: ${{ github.run_id }}:${{ github.run_attempt }}:${{ github.job }}
    CI_JOB_STATUS: ${{ job.status }}
  run: node examples/apps/ci-webhook.mjs
```

This example derives a UUID from the stable delivery ID. Use a new delivery ID for a new update. Never use a human session token as an app credential. Tokens are sent only in Authorization, never in URL query strings.

## Slash commands

Install Ping in a text channel and enter `/ping` to get a bot-authored `Pong!`. Typing `/` opens the channel's command list. External apps register up to 20 commands in their configuration:

```json
{
  "name":"hello",
  "description":"Say hello",
  "arguments":[{"name":"name","type":"string","required":true}]
}
```

Each command accepts up to 10 unique named arguments of type `string`, `integer` or `boolean`. Strings are limited to 1,000 characters and integers to signed 32-bit values. The chat composer accepts positional values (`/hello "World traveler"`); if apps share a command name, choosing it from the list inserts an app ID suffix. Commands run at channel level, without attachments or a reply/thread target.

The wire contract uses named arguments and a stable invocation UUID:

```http
POST /api/channels/general/commands
Content-Type: application/json
[human session cookie or bearer Authorization]

{"id":"a2023a9c-5735-4d11-90ce-37f367511229","appId":"APP_ID","name":"hello","arguments":{"name":"World"}}
```

Members can list granted commands with `GET /api/channels/:channelId/commands`. Unknown/missing arguments, type mismatches and unknown commands are rejected. Successful invocations return `{id,status,message,error}`; Ping completes immediately. External commands initially return `pending`; the chat composer polls for completion/failure. `GET /api/channels/:channelId/commands/:invocationId` is accessible only to the invoking member while they retain channel membership. Retrying the same invocation returns its existing result; changing its content returns `409`.

The app endpoint receives a signed `command.invoked` event and must return `application/json` with `{"text":"Hello World!"}` (1–4,000 characters) within ten seconds. The response becomes a bot post in the invocation's channel. There is no independent callback token or deferred response API in this milestone.

## Outbound events and signatures

Configure an approved `endpointUrl` and optionally subscribe to `message.created`. Commands implicitly subscribe to `command.invoked`:

```json
{"id":"stable-event-id","type":"command.invoked","createdAt":1790000000000,
 "data":{"workspaceId":"main","channelId":"general","userId":"opaque-member-id",
 "name":"hello","arguments":{"name":"World"}}}
```

`message.created` data contains `workspaceId`, `channelId`, `messageId`, `authorId`, `text` and nullable `threadId`. It excludes historical messages, attachments and session credentials. Bot/system-authored messages never enqueue events, preventing recursive app chains. Events are written atomically with human messages, including file-backed posts.

Every POST includes:

- `X-Anycord-Event-Id`: stable ID from the body; unchanged across attempts.
- `X-Anycord-Timestamp`: current Unix time in seconds for this attempt.
- `X-Anycord-Signature`: `v1=` plus hex HMAC-SHA256 using the signing secret over `timestamp + "." + rawBody`.

Verify the signature in constant time against the **raw bytes**, reject timestamps more than five minutes old, check the header/body IDs match, then durably deduplicate by event ID before any side effect. Store and return the same command response on duplicate delivery. An HTTP success is acknowledged; redirects, non-2xx, timeouts and invalid command responses retry with exponential backoff (30 seconds to a maximum 15 minutes), at most five attempts. A minute scheduler and immediate dispatch drain the persistent outbox; processing is limited to ten events per pass. Expired 60-second leases can be reclaimed, so delivery is **at least once**, with no ordering guarantee. New signatures/timestamps do not mean a new event.

[The working receiver](../examples/apps/event-receiver.mjs) verifies signatures and uses persistent SQLite receipts; run it behind HTTPS at an approved origin:

```sh
ANYCORD_SIGNING_SECRET=... ANYCORD_EVENTS_DB=/persistent/app-events.sqlite \
node examples/apps/event-receiver.mjs
```

Configure its URL as `https://hooks.example.com/anycord` and register the `hello` command above. The example stores the event as its side effect. For an external side effect, propagate the event ID as an idempotency key or use a transactional outbox; a receipt by itself cannot make unrelated external writes atomic.

## Revocation, limits and operations

Requests and dispatch re-check the current policy, app status, server/channel grant and credential. Command responses additionally re-check caller membership. Rotation changes the incoming token and signing secret. Configuration changes, rotation, disabling, uninstall and installation policy changes cancel pending events/invocations; uninstall removes credentials and grants. Already-sent network traffic cannot be recalled, and receivers must stop accepting the old signing key when rotating.

Limits: 20 installed apps per server, 50 granted channels per app, 30 incoming requests per app per minute, 15 command invocations per member/server per minute, plus existing human write limits. A `429` response includes `Retry-After: 60`; duplicate incoming attempts count toward limits. Audit records cover installs/configuration/disabling/uninstall, rotation, policy changes, accepted posts and failed/cancelled deliveries, with IDs and timestamps and no secrets or message contents. The UI returns the latest 100 records/deliveries, shows 12, and a scheduled sweep retains terminal deliveries for seven days and audit records for 30 days. Message receipts and invocation IDs remain durable for idempotency.

API details live in `shared/apps.ts` and `shared/api.ts`. Validate locally with `npm run test:apps` and `npm run verify`. Tests run both actual Worker entrypoints with disposable D1/DO state, without provisioning Cloudflare resources.

## Slack-compatible incoming webhooks

Anycord supports the **plain-text incoming webhook subset** of Slack's protocol. An existing sender using a configurable Slack webhook URL can post `{"text":"Build passed"}` and receive HTTP `200`, `text/plain`, `ok`. The official `@slack/webhook` Node SDK is exercised against both Worker entrypoints in the tests. This is independent of Slack's service and does not require a Slack account.

In Server Settings → Apps & integrations, install/configure an app and grant its channels. In the app's **Slack incoming webhooks** section, choose a channel and create a URL. There is one URL per app/channel. Copy the secret URL immediately; listing webhooks returns metadata only. Rotation replaces its secret; revocation deletes its access. Disabling the app or installation policy blocks it while disabled. Removing its channel grant permanently revokes the URL, including if the channel is later granted again. Rotating the app's general credentials or uninstalling the app also revokes all its Slack URLs.

```sh
curl --fail-with-body "$SLACK_WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  --data '{"text":"Build passed"}'
```

Or reuse an ordinary SDK sender:

```js
import { IncomingWebhook } from '@slack/webhook'
await new IncomingWebhook(process.env.SLACK_WEBHOOK_URL).send({ text: 'Build passed' })
```

The runnable [Slack SDK example](../examples/apps/slack-webhook.mjs) reads `SLACK_WEBHOOK_URL` and optionally `CI_JOB_STATUS`/`GITHUB_REPOSITORY`. `@slack/webhook` is a development/test dependency, not part of Anycord's runtime bundle.

The webhook URL is a capability restricted to **one channel and its app identity**. It needs no Authorization header and never uses a human session. Legacy `channel`, `username`, `icon_url` and `icon_emoji` fields are accepted but ignored; they cannot override the configured destination or identity. `mrkdwn`, `unfurl_links` and `unfurl_media` flags are accepted for sender interoperability; messages render as Anycord text without rich Slack formatting, unfurling or mass-mention expansion. Text is required and limited to 4,000 characters; JSON bodies are limited to 20,000 bytes.

`blocks`, `attachments`, `thread_ts` and `metadata` explicitly return HTTP `400`/`unsupported_payload`, even when fallback text exists. Other unknown fields and malformed JSON return `invalid_payload`. Missing/blank text returns `no_text`. This milestone does not implement Block Kit, files, thread targeting, OAuth, Slack Web API methods, Events API, Slack-format slash commands, Workflow Builder or Marketplace installation.

Ordinary requests create separate messages, including identical repeated text. For safe retries, Anycord additionally accepts an **optional** `Idempotency-Key` header (1–128 ASCII letters/digits or `._:-`). This is an Anycord extension, not a Slack requirement. Reuse the same key and text on the same webhook to converge on one durable message, including concurrent requests. Changed text or a deleted original message returns HTTP `409`/`idempotency_conflict`. Keys are scoped by webhook ID and survive rotation of that webhook's secret; newly created webhooks have independent keys. A webhook URL itself cannot retrieve message history or reaction/thread metadata.

Errors are plain text: `invalid_token` (`404`, including revoked URLs), `action_prohibited` (`403`, including disabled policy/app or changed grants), `invalid_payload` (`400`, or `413`/`415` for body/type limits), `no_text`/`unsupported_payload` (`400`), `idempotency_conflict` (`409`), `rate_limited` (`429`, with `Retry-After: 60`), `method_not_allowed` (`405`) and `internal_error` (`500`). All URL and bearer credentials of an app share the 30 requests/minute app budget, preventing additional URLs from bypassing its limit.

Treat the entire webhook URL as a secret. Anycord stores only the secret's hash, never lists it again, never redirects incoming posts, and omits capability URLs/payloads from application errors/logs. Configure reverse-proxy/platform access logs to redact these secret URL paths too. Audit events record `slack_webhook.created`, `.rotated` and `.revoked` without secrets. Slack bot posts do not produce outbound app events or Telegram alerts.

The reference protocol is documented in [Slack's incoming webhook guide](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/); supported differences and limits are listed above.

Commands require the invoking member to retain channel visibility, message history and send permissions. Permission changes cancel pending commands, including replies awaiting an external endpoint. App channel grants are explicit server-owner grants and remain independent of human roles.

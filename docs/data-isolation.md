# Data isolation: current implementation and alternatives

An installation is the deployment boundary: its own backend address, accounts, database and object store. Servers are communities inside that installation. Separate remote installations do not share these resources. The current Cloudflare adapter uses one D1 per installation, with application authorization between its servers. This document describes the current implementation, not a new database-per-server implementation.

Decision (2026-10-15): keep the shared D1 for now. The existing `workspace_id` serves as the tenant/server key; an explicit tenant-scoped repository interface, stronger constraints and per-server database alternatives are tracked in [issue #1](https://github.com/inchidev/anycord/issues/1). This decision does not introduce a new `tenant_id` column or change existing records.

## How current reads and joins are scoped

`worker/router.ts` checks `requireMembership(user.id, workspaceId)` before a server search. The query then joins messages to channels and applies `channels.workspace_id = workspaceId`; the search text is a bound parameter. Simplified equivalent SQL:

```sql
-- The route checks this before querying server data:
SELECT role FROM memberships WHERE user_id = ? AND workspace_id = ?;
-- No membership means 403, even if the caller guesses a valid server ID.

SELECT m.id, m.text, c.id AS channel_id, u.name AS author
FROM messages AS m
JOIN channels AS c ON c.id = m.channel_id
JOIN users AS u ON u.id = m.author_id
WHERE c.workspace_id = ? AND instr(lower(m.text), lower(?)) > 0
ORDER BY m.created_at DESC LIMIT 40;
```

Channel routes resolve the channel's server and check membership through `requireChannel`. History reads constrain `messages.channel_id`; reply previews also constrain their source channel/conversation. Thread lookup constrains its channel. Message creation rejects foreign-channel replies and threads. Attachment linking checks channel, owner and status atomically; downloads check channel membership before granting short-lived signed access. Realtime objects are selected by server ID after membership authorization. A realtime Durable Object does not partition the SQL database.

The integration harness creates two servers and tests private search rejection, absence of private messages from the other server's search even when the caller belongs to both, foreign message focus/reply rejection, private attachment access and channel/thread context separation.

## Limits of this boundary

The shared D1 binding can query every row. Membership enforcement is application code, not a per-server database credential or database-enforced row security policy. Helpers such as `getMessages` assume the caller already authorized the channel. A future endpoint that omits those checks or the server/channel predicate could leak data. Existing tests cover the implemented paths; they are not proof that every future query will be correct.

Current foreign keys establish record existence, but do not encode every same-channel relationship as a composite foreign key. The API enforces those relationships. Membership checks and reads are separate operations; future membership revocation needs a deliberate concurrency policy. A scoped repository interface, constrained relationships and broader negative isolation tests are reasonable hardening steps without changing deployment topology.

Object keys are currently opaque `attachments/<uuid>` values, not server prefixes. Private storage plus authorized metadata/signatures controls reads. A prefix can organize data, but does not provide access control by itself.

## Alternative: control database plus server databases

A stronger boundary would keep accounts, sessions, server directory and memberships in an installation control D1, and store channels/messages/threads/reactions in a separate D1 per server. The Worker would authenticate in the control DB, authorize membership, select the server's registered database, then execute community queries there. Chat joins stay within that server database. Author display profiles would be projected into it or hydrated separately; ordinary SQL joins would not span the control/server databases. Global search would fan out only to authorized servers.

That design requires database provisioning and routing, per-database migrations/backups/deletion, profile synchronization and cross-database consistency handling. The Worker must still authorize the selected server: per-server databases do not prevent selecting the wrong database. It also changes celld and future engine adapters. It is not implemented or migrated by this frontend fix.

Cloudflare documents both [database-per-tenant and shared row separation](https://developers.cloudflare.com/use-cases/saas/data-isolation/). Its [D1 FAQ](https://developers.cloudflare.com/d1/reference/faq/) describes scale-out across smaller per-tenant/entity databases. Choosing the stronger boundary is a product/operations decision; it is not an automatic consequence of having several communities in one installation.

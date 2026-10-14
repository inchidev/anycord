# Anycord

A familiar chat client for independent communities. Run an installation on Cloudflare or self-host with celld, then connect to it from the same Nuxt client.

- Channels, live messages, presence, typing, replies, reactions, quotes and threads.
- Private image/file attachments using native R2 or configurable S3-compatible storage.
- Multiple communities on one installation, with membership checked for every server, channel, message, search and file request.
- Independent remote connections, accounts and drafts.
- Optional Cloudflare RealtimeKit huddles and OpenRouter assistant integration.

The Nuxt frontend is generated as a static SPA. There is no separate Nitro application server. celld and native Cloudflare implement the shared API; TrailBase and PocketBase adapters are planned. See [API contract](API_CONTRACT.md), [engine research](ENGINE_RESEARCH.md) and [deployment](DEPLOYMENT.md).

## Self-host

```sh
npm ci
node scripts/setup-storage.mjs
docker compose --env-file .env.storage -f compose.yml -f compose.rustfs.yml up -d --build --wait
```

On macOS with Colima, set `DOCKER_CONTEXT=colima` for the setup command and pass `--context colima` to Docker. Open `http://127.0.0.1:9876/login`, create the first account, then choose a server. The first account owns the installation. Production deployments should set `AUTH_BASE_URL` to their HTTPS origin and keep RustFS on the internal network. Back up both `chat-state` and `rustfs-data`, including the application's encryption key.

Better Auth owns username/password accounts and signed sessions. Passwords require at least ten characters, with confirmation during registration. Save recovery keys in User Settings → Recovery keys; `/recover` resets the password without email and revokes old sessions and keys. Email delivery is not implemented yet. Optional service credentials stay encrypted on the installation and are managed by its owner in User Settings → Installation Settings.

## Installations and servers

An **installation** has its own address, accounts, database and file storage. A **server** is a community inside that installation, with its own members and channels. One installation can host several servers. Logging into an installation lists only servers where the account is a member; it does not grant access to all communities.

`/` is the product landing; `/login` is sign-in; `/servers` chooses a community; `/<serverId>/<channelId>` opens chat. The first server has the opaque ID `main`; additional servers receive UUIDs. Display names can change independently of IDs.

Only the installation owner can create new servers. The initial `main` server accepts accounts registered on its installation. Other servers belong to their creator until people join through server-scoped invitations. Server owners create/revoke links, set expiration and usage limits, remove members, ban them and remove bans in Server Settings. Custom roles and channel permissions are the next milestone in the [roadmap](docs/roadmap.md). Remote installations have independent identities/history. One installation is active per client tab; federation, shared global login and aggregate background notifications are not implemented.

## Resources and isolation

| Engine | Per installation | Per server |
| --- | --- | --- |
| Cloudflare | One Worker with client assets, one D1 database, one private R2 bucket | Rows scoped by workspace/channel membership; one WorkspaceHub Durable Object for realtime |
| celld | One celld process/container, a D1-compatible application database, configurable S3/RustFS storage | The same membership model and WorkspaceHub separation, emulated locally |
| TrailBase / PocketBase | Proposed: one backend database and configured file store per installation | Proposed: workspace-scoped records and equivalent authorization/realtime adapters |

Cloudflare also has an installation-level auth/rate-limit Hub and a retained legacy ChatRoom class. Attachments use opaque object keys in shared storage; access is authorized through their channel/server and time-limited download grants. Creating a community does not provision a new Worker, D1 database or bucket. This is application-level isolation on shared installation resources, not a dedicated infrastructure boundary per community. See [data isolation and database-per-server alternatives](docs/data-isolation.md) for the current query checks and their limits. Future engines must enforce the same contract; their adapters are not shipped yet.

## Installed app and releases

Install Anycord from the landing or server-picker page. The PWA provides an offline app shell, keeps account-scoped drafts and prompts before updating; conversations require connectivity. See [PWA behavior and platform verification](docs/pwa.md).

Changes arrive through PRs to main. Published versions are immutable and production promotion is explicit; independent installations choose their own updates. See [contributing](CONTRIBUTING.md) and [release procedures](docs/releases.md).

## Development

```sh
npm run verify
npm run test:servers
npm run test:connections
```

`npm run verify` checks TypeScript, API contracts, real draft/message/server-list composables, connection isolation, navigation and the production build. The Docker integration harness additionally checks two-client realtime delivery, auth, server isolation, restart persistence and real RustFS file operations in disposable stores. Run it with `node scripts/run-integration.mjs` after building the local image and storage stack.

Public brand assets are under `public/brand/`; [generation prompts](docs/brand-prompt.txt) are included. Local state, environment files, build outputs, screenshots and operational backups are excluded from Git.

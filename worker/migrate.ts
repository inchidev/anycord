import migrations from './migrations.json'

export async function applyMigrations(db: D1Database, target?: string) {
  await db.exec('CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const applied: string[] = []
  for (const migration of migrations) {
    if (target && migration.name > target) break
    const exists = await db.prepare('SELECT name FROM app_migrations WHERE name = ?').bind(migration.name).first()
    if (exists) continue
    // D1 batch is transactional. A failed migration does not record itself as applied.
    await db.batch([
      ...migration.statements.map((statement) => db.prepare(statement)),
      db.prepare('INSERT INTO app_migrations (name, applied_at) VALUES (?, ?)').bind(migration.name, Date.now()),
    ])
    applied.push(migration.name)
  }
  return { applied, latest: migrations.at(-1)?.name }
}

export async function seedDatabase(db: D1Database, legacy: { id: string; name: string; text: string; sentAt: number }[] = []) {
  const now = Date.now()
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO workspaces (id, name, initials) VALUES ('main', 'Local server', 'LS')"),
    db.prepare("INSERT OR IGNORE INTO users (id, name, password_hash, color, role, created_at) VALUES ('system', 'Anycord', 'disabled', '#5865f2', 'bot', ?)").bind(now),
    db.prepare("INSERT OR IGNORE INTO channels (id, workspace_id, name, topic, kind, position) VALUES ('general', 'main', 'general', 'The place for everything. Say hello!', 'text', 0)"),
    db.prepare("INSERT OR IGNORE INTO channels (id, workspace_id, name, topic, kind, position) VALUES ('introductions', 'main', 'introductions', 'Tell us a little about yourself.', 'text', 1)"),
    db.prepare("INSERT OR IGNORE INTO channels (id, workspace_id, name, topic, kind, position) VALUES ('build-log', 'main', 'build-log', 'Share what you are working on.', 'text', 2)"),
    db.prepare("INSERT OR IGNORE INTO channels (id, workspace_id, name, topic, kind, position) VALUES ('hangout', 'main', 'Hangout', 'Drop in for a live huddle.', 'voice', 3)"),
    db.prepare("INSERT OR IGNORE INTO messages (id, channel_id, author_id, text, created_at) VALUES ('welcome', 'general', 'system', 'Welcome to your server. This is the beginning of #general. Say hello, share a file, or start a thread to keep the conversation going.', ?)").bind(now),
  ])
  const imported = await db.prepare("SELECT value FROM settings WHERE key = 'legacy_imported'").first()
  if (!imported) {
    for (const message of legacy) {
      const id = `legacy-${message.name}`
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO users (id, name, password_hash, color, role, created_at) VALUES (?, ?, 'disabled', '#949ba4', 'legacy', ?)").bind(id, `${message.name} (previous demo)`, now),
        db.prepare('INSERT OR IGNORE INTO messages (id, channel_id, author_id, text, created_at) VALUES (?, ?, ?, ?, ?)').bind(message.id, 'general', id, message.text, message.sentAt),
      ])
    }
    await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('legacy_imported', 'true')").run()
  }
  const authReady = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_user'").first()
  if (authReady) {
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO auth_user (id, name, email, email_verified, username, created_at, updated_at) SELECT id, name, id || '@local.cellcord.invalid', 0, lower(name), created_at, created_at FROM users WHERE role IN ('owner', 'member')"),
      db.prepare("INSERT OR IGNORE INTO auth_account (id, account_id, provider_id, user_id, password, created_at, updated_at) SELECT 'credential:' || id, id, 'credential', id, password_hash, created_at, created_at FROM users WHERE role IN ('owner', 'member') AND password_hash != 'disabled'"),
      db.prepare("UPDATE users SET password_hash = 'disabled' WHERE EXISTS (SELECT 1 FROM auth_account WHERE auth_account.user_id = users.id AND provider_id = 'credential')"),
    ])
  }
}

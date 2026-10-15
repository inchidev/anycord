CREATE TABLE `installation_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`phase` text NOT NULL,
	`requested_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`target_version` text,
	`target_commit` text,
	`runner_id` text,
	`claim_hash` text,
	`checkpoint` text,
	`result` text,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `installation_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`maintenance_job` text,
	`outbound_disabled` integer DEFAULT 0 NOT NULL,
	`runner_seen` integer,
	`backup_hours` integer DEFAULT 0 NOT NULL,
	`retain_backups` integer DEFAULT 7 NOT NULL,
	`last_backup` integer
);

--> statement-breakpoint
INSERT INTO installation_state (id,installation_id) VALUES (1,lower(hex(randomblob(16))));
--> statement-breakpoint
CREATE UNIQUE INDEX installation_one_active_job ON installation_jobs ((1)) WHERE status IN ('queued','running');
--> statement-breakpoint
CREATE TRIGGER maintenance_app_migrations_insert BEFORE INSERT ON app_migrations WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_app_migrations_update BEFORE UPDATE ON app_migrations WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_app_migrations_delete BEFORE DELETE ON app_migrations WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_users_insert BEFORE INSERT ON users WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_users_update BEFORE UPDATE ON users WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_users_delete BEFORE DELETE ON users WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_auth_user_insert BEFORE INSERT ON auth_user WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_auth_user_update BEFORE UPDATE ON auth_user WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_auth_user_delete BEFORE DELETE ON auth_user WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_auth_account_insert BEFORE INSERT ON auth_account WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_auth_account_update BEFORE UPDATE ON auth_account WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_auth_account_delete BEFORE DELETE ON auth_account WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_workspaces_insert BEFORE INSERT ON workspaces WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_workspaces_update BEFORE UPDATE ON workspaces WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_workspaces_delete BEFORE DELETE ON workspaces WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_memberships_insert BEFORE INSERT ON memberships WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_memberships_update BEFORE UPDATE ON memberships WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_memberships_delete BEFORE DELETE ON memberships WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_channels_insert BEFORE INSERT ON channels WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_channels_update BEFORE UPDATE ON channels WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_channels_delete BEFORE DELETE ON channels WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_messages_insert BEFORE INSERT ON messages WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_messages_update BEFORE UPDATE ON messages WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_messages_delete BEFORE DELETE ON messages WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_threads_insert BEFORE INSERT ON threads WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_threads_update BEFORE UPDATE ON threads WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_threads_delete BEFORE DELETE ON threads WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_reactions_insert BEFORE INSERT ON reactions WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_reactions_update BEFORE UPDATE ON reactions WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_reactions_delete BEFORE DELETE ON reactions WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_settings_insert BEFORE INSERT ON settings WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_settings_update BEFORE UPDATE ON settings WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_settings_delete BEFORE DELETE ON settings WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_storage_configs_insert BEFORE INSERT ON storage_configs WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_storage_configs_update BEFORE UPDATE ON storage_configs WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_storage_configs_delete BEFORE DELETE ON storage_configs WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_attachments_insert BEFORE INSERT ON attachments WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_attachments_update BEFORE UPDATE ON attachments WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_attachments_delete BEFORE DELETE ON attachments WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_invitations_insert BEFORE INSERT ON invitations WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_invitations_update BEFORE UPDATE ON invitations WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_invitations_delete BEFORE DELETE ON invitations WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_recovery_keys_insert BEFORE INSERT ON recovery_keys WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_recovery_keys_update BEFORE UPDATE ON recovery_keys WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_recovery_keys_delete BEFORE DELETE ON recovery_keys WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_workspace_bans_insert BEFORE INSERT ON workspace_bans WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_workspace_bans_update BEFORE UPDATE ON workspace_bans WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_workspace_bans_delete BEFORE DELETE ON workspace_bans WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_telegram_preferences_insert BEFORE INSERT ON telegram_preferences WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_telegram_preferences_update BEFORE UPDATE ON telegram_preferences WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_telegram_preferences_delete BEFORE DELETE ON telegram_preferences WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_thread_followers_insert BEFORE INSERT ON thread_followers WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_thread_followers_update BEFORE UPDATE ON thread_followers WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_thread_followers_delete BEFORE DELETE ON thread_followers WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_huddles_insert BEFORE INSERT ON huddles WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_huddles_update BEFORE UPDATE ON huddles WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_huddles_delete BEFORE DELETE ON huddles WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_huddle_participants_insert BEFORE INSERT ON huddle_participants WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_huddle_participants_update BEFORE UPDATE ON huddle_participants WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_huddle_participants_delete BEFORE DELETE ON huddle_participants WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_telegram_outbox_insert BEFORE INSERT ON telegram_outbox WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_telegram_outbox_update BEFORE UPDATE ON telegram_outbox WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_telegram_outbox_delete BEFORE DELETE ON telegram_outbox WHEN EXISTS (SELECT 1 FROM installation_state WHERE id=1 AND maintenance_job IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'Anycord maintenance: writes are paused'); END;

--> statement-breakpoint
ALTER TABLE `installation_jobs` ADD `target_schema` text;--> statement-breakpoint
ALTER TABLE `installation_jobs` ADD `target_api_version` integer;
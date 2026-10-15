CREATE TABLE `app_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`app_id` text,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `app_audit_workspace` ON `app_audit` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `app_invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text NOT NULL,
	`message_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `server_apps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `app_message_requests` (
	`app_id` text NOT NULL,
	`request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`message_id` text NOT NULL,
	PRIMARY KEY(`app_id`, `request_id`),
	FOREIGN KEY (`app_id`) REFERENCES `server_apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `app_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`due_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`lease` text,
	`last_error` text,
	FOREIGN KEY (`app_id`) REFERENCES `server_apps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `app_outbox_due` ON `app_outbox` (`status`,`due_at`);--> statement-breakpoint
CREATE TABLE `server_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`bot_user_id` text NOT NULL,
	`name` text NOT NULL,
	`avatar_url` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`channel_ids` text NOT NULL,
	`enabled` integer NOT NULL,
	`endpoint_url` text DEFAULT '' NOT NULL,
	`events` text NOT NULL,
	`commands` text NOT NULL,
	`token_hash` text NOT NULL,
	`signing_secret` text NOT NULL,
	`created_at` integer NOT NULL,
	`uninstalled_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bot_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `server_apps_bot_user_id_unique` ON `server_apps` (`bot_user_id`);--> statement-breakpoint
CREATE INDEX `server_apps_workspace` ON `server_apps` (`workspace_id`);--> statement-breakpoint
ALTER TABLE `messages` ADD `app_id` text REFERENCES server_apps(id);--> statement-breakpoint
ALTER TABLE `messages` ADD `app_request_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `app_request_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_app_request` ON `messages` (`app_id`,`app_request_id`);
--> statement-breakpoint
-- Enqueue in the message transaction: a process crash cannot lose an acknowledged event.
CREATE TRIGGER app_message_event AFTER INSERT ON messages
WHEN (SELECT role FROM users WHERE id = NEW.author_id) != 'bot'
BEGIN
  INSERT INTO app_outbox (id, app_id, channel_id, type, payload, due_at, created_at)
  SELECT a.id || ':' || NEW.id, a.id, NEW.channel_id, 'message.created',
    json_object('id', a.id || ':' || NEW.id, 'type', 'message.created', 'createdAt', NEW.created_at,
      'data', json_object('workspaceId', a.workspace_id, 'channelId', NEW.channel_id, 'messageId', NEW.id,
        'authorId', NEW.author_id, 'text', NEW.text, 'threadId', NEW.thread_id)), NEW.created_at, NEW.created_at
  FROM server_apps a JOIN channels c ON c.workspace_id = a.workspace_id AND c.id = NEW.channel_id
  WHERE a.enabled = 1 AND a.uninstalled_at IS NULL AND a.endpoint_url != ''
    AND EXISTS (SELECT 1 FROM json_each(a.channel_ids) WHERE value = NEW.channel_id)
    AND EXISTS (SELECT 1 FROM json_each(a.events) WHERE value = 'message.created')
    AND EXISTS (SELECT 1 FROM settings s, json_each(s.value, '$.allowedOrigins') origin
      WHERE s.key = 'appsPolicy' AND json_extract(s.value, '$.enabled') = 1
      AND substr(a.endpoint_url, 1, length(origin.value) + 1) = origin.value || '/')
  ON CONFLICT(id) DO NOTHING;
END;
--> statement-breakpoint
CREATE TRIGGER app_install_limit BEFORE INSERT ON server_apps
WHEN (SELECT count(*) FROM server_apps WHERE workspace_id = NEW.workspace_id AND uninstalled_at IS NULL) >= 20
BEGIN
  SELECT RAISE(ABORT, 'Server app limit reached');
END;

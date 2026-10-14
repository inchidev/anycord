CREATE TABLE `telegram_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`message_id` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`due_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `telegram_outbox_due` ON `telegram_outbox` (`status`,`due_at`);--> statement-breakpoint
CREATE TABLE `telegram_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`preview` integer DEFAULT false NOT NULL,
	`messaging_allowed` integer DEFAULT false NOT NULL,
	`muted_channel_ids` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `thread_followers` (
	`thread_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`thread_id`, `user_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_telegram_identity` ON `auth_account` (`provider_id`,`account_id`) WHERE "auth_account"."provider_id" = 'telegram';--> statement-breakpoint
CREATE UNIQUE INDEX `auth_telegram_user` ON `auth_account` (`user_id`) WHERE "auth_account"."provider_id" = 'telegram';
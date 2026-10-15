CREATE TABLE `app_slack_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `server_apps`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_slack_webhooks_channel` ON `app_slack_webhooks` (`app_id`,`channel_id`);
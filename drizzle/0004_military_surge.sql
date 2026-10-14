CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`message_id` text,
	`storage_id` text NOT NULL,
	`object_key` text NOT NULL,
	`name` text NOT NULL,
	`size` integer NOT NULL,
	`content_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`storage_id`) REFERENCES `storage_configs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attachments_message` ON `attachments` (`message_id`);--> statement-breakpoint
CREATE INDEX `attachments_pending` ON `attachments` (`created_at`);--> statement-breakpoint
CREATE TABLE `live_tickets` (
	`hash` text PRIMARY KEY NOT NULL,
	`authorization` text NOT NULL,
	`origin` text NOT NULL,
	`workspace_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `storage_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`config` text NOT NULL
);

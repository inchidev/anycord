CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`parent_message_id` text,
	`name` text NOT NULL,
	`author_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `threads_parent_message_id_unique` ON `threads` (`parent_message_id`);--> statement-breakpoint
CREATE INDEX `threads_channel_time` ON `threads` (`channel_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `messages` ADD `reply_to_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `thread_id` text REFERENCES threads(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `messages_thread_time` ON `messages` (`thread_id`,`created_at`);

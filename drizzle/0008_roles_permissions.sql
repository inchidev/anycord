CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`target_id` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_workspace_time` ON `audit_events` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `channel_overrides` (
	`channel_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`permission` text NOT NULL,
	`effect` text NOT NULL,
	PRIMARY KEY(`channel_id`, `subject_type`, `subject_id`, `permission`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `member_roles` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`, `role_id`),
	FOREIGN KEY (`workspace_id`,`role_id`) REFERENCES `roles`(`workspace_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`workspace_id`) REFERENCES `memberships`(`user_id`,`workspace_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_id` text NOT NULL,
	`permission` text NOT NULL,
	PRIMARY KEY(`role_id`, `permission`),
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#949ba4' NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_workspace_id` ON `roles` (`workspace_id`,`id`);--> statement-breakpoint
CREATE INDEX `roles_workspace_position` ON `roles` (`workspace_id`,`position`);
--> statement-breakpoint
INSERT INTO roles (id, workspace_id, name, color, position) SELECT 'everyone:' || id, id, '@everyone', '#949ba4', 0 FROM workspaces;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission) SELECT id, 'channels.view' FROM roles WHERE id = 'everyone:' || workspace_id;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission) SELECT id, 'messages.read' FROM roles WHERE id = 'everyone:' || workspace_id;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission) SELECT id, 'messages.send' FROM roles WHERE id = 'everyone:' || workspace_id;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission) SELECT id, 'reactions.add' FROM roles WHERE id = 'everyone:' || workspace_id;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission) SELECT id, 'threads.create' FROM roles WHERE id = 'everyone:' || workspace_id;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission) SELECT id, 'attachments.upload' FROM roles WHERE id = 'everyone:' || workspace_id;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission) SELECT id, 'voice.connect' FROM roles WHERE id = 'everyone:' || workspace_id;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission) SELECT id, 'voice.speak' FROM roles WHERE id = 'everyone:' || workspace_id;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission) SELECT id, 'ai.ask' FROM roles WHERE id = 'everyone:' || workspace_id;

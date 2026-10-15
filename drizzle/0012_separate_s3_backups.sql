CREATE TABLE `installation_backups` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`manifest_hash` text NOT NULL,
	`manifest_key` text NOT NULL,
	`destination` text NOT NULL
);

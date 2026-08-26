ALTER TABLE `camera_live_sources` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `camera_live_sources` ADD `verified_at` integer;--> statement-breakpoint
ALTER TABLE `camera_live_sources` ADD `policy_digest` text;--> statement-breakpoint
ALTER TABLE `cameras` ADD `name_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `cameras_name_key_unique` ON `cameras` (`name_key`);
CREATE TABLE `cameras` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text,
	`enabled` integer DEFAULT true
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cameras_name_unique` ON `cameras` (`name`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sensor_id` text,
	`type` text NOT NULL,
	`payload` text,
	`created_at` integer,
	`sent_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_events_unsent` ON `events` (`sent_at`);--> statement-breakpoint
CREATE INDEX `idx_events_sensor_time` ON `events` (`sensor_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `features` (
	`name` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false,
	`installed` integer DEFAULT false,
	`config` text
);
--> statement-breakpoint
CREATE TABLE `invite_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`created_by` integer,
	`used_by` integer,
	`created_at` integer,
	`used_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`telegram_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `motion_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`camera_id` text,
	`started_at` integer,
	`ended_at` integer,
	`video_path` text,
	`snapshot_path` text,
	`uploaded_to_gdrive` integer DEFAULT false,
	`gdrive_file_id` text,
	`local_deleted` integer DEFAULT false,
	FOREIGN KEY (`camera_id`) REFERENCES `cameras`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_motion_camera_time` ON `motion_events` (`camera_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_motion_not_uploaded` ON `motion_events` (`uploaded_to_gdrive`);--> statement-breakpoint
CREATE TABLE `sensor_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sensor_id` text,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`timestamp` integer
);
--> statement-breakpoint
CREATE INDEX `idx_sensor_logs_sensor_time` ON `sensor_logs` (`sensor_id`,`timestamp`);--> statement-breakpoint
CREATE TABLE `sensors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text,
	`enabled` integer DEFAULT true,
	`debounce_ms` integer DEFAULT 10000,
	`severity` text DEFAULT 'info',
	`last_value` text,
	`last_value_at` integer,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sensors_name_unique` ON `sensors` (`name`);--> statement-breakpoint
CREATE TABLE `sensors_archive` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text,
	`debounce_ms` integer,
	`severity` text,
	`last_value` text,
	`last_value_at` integer,
	`created_at` integer,
	`archived_at` integer
);
--> statement-breakpoint
CREATE TABLE `system_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `user_sensor_mutes` (
	`user_id` integer,
	`sensor_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`telegram_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_user_sensor_mute` ON `user_sensor_mutes` (`user_id`,`sensor_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`telegram_id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`muted` integer DEFAULT false,
	`quiet_start` text,
	`quiet_end` text,
	`created_by` integer,
	`created_at` integer
);

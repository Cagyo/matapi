CREATE TABLE `archive_provider_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`generation_id` text,
	`operation_class` text,
	`failure_class` text,
	`failure_streak` integer DEFAULT 0 NOT NULL,
	`cooldown_until` integer,
	`block_reason` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT "archive_provider_state_singleton_check" CHECK("archive_provider_state"."id" = 1),
	CONSTRAINT "archive_provider_state_revision_check" CHECK("archive_provider_state"."revision" >= 0),
	CONSTRAINT "archive_provider_state_failure_streak_check" CHECK("archive_provider_state"."failure_streak" >= 0)
);
--> statement-breakpoint
CREATE TABLE `drive_motion_folder_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`generation_id` text NOT NULL,
	`normalized_path` text NOT NULL,
	`level` text NOT NULL,
	`segment_name` text NOT NULL,
	`folder_id` text NOT NULL,
	`parent_folder_id` text NOT NULL,
	`state` text NOT NULL,
	`current_slot` integer,
	`revision` integer NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`verified_at` integer,
	CONSTRAINT "drive_motion_folder_state_check" CHECK("drive_motion_folder_reservations"."state" in ('reserved','verified','missing','detached','conflict','superseded')),
	CONSTRAINT "drive_motion_folder_slot_check" CHECK("drive_motion_folder_reservations"."current_slot" is null or "drive_motion_folder_reservations"."current_slot" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_drive_motion_folder_current_path` ON `drive_motion_folder_reservations` (`generation_id`,`normalized_path`) WHERE "drive_motion_folder_reservations"."current_slot" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_drive_motion_folder_id` ON `drive_motion_folder_reservations` (`folder_id`);--> statement-breakpoint
ALTER TABLE `archive_artifacts` ADD `admission_state` text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE `archive_artifacts` ADD `motion_day_path` text;--> statement-breakpoint
ALTER TABLE `archive_artifacts` ADD `admission_next_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `archive_artifacts` ADD `admission_error_code` text;--> statement-breakpoint
ALTER TABLE `archive_artifacts` ADD `admission_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `archive_scheduler_state` ADD `last_motion_traversal_success_ms` integer;--> statement-breakpoint
ALTER TABLE `archive_scheduler_state` ADD `last_artifact_registration_success_ms` integer;
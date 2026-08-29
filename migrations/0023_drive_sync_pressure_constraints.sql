PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_archive_scheduler_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`backup_lease_owner` text,
	`backup_lease_expires_at` integer,
	`last_backup_success_ms` integer,
	`last_upload_success_ms` integer,
	`last_reconcile_success_ms` integer,
	`last_cleanup_success_ms` integer,
	`last_motion_traversal_success_ms` integer,
	`last_artifact_registration_success_ms` integer,
	`last_plausible_wall_time_ms` integer,
	`clock_health` text DEFAULT 'healthy' NOT NULL,
	`observed_rollback_ms` integer,
	CONSTRAINT "archive_scheduler_state_singleton_check" CHECK("__new_archive_scheduler_state"."id" = 1),
	CONSTRAINT "archive_scheduler_state_revision_check" CHECK("__new_archive_scheduler_state"."revision" >= 0),
	CONSTRAINT "archive_scheduler_state_lease_check" CHECK(("__new_archive_scheduler_state"."backup_lease_owner" is null and "__new_archive_scheduler_state"."backup_lease_expires_at" is null) or ("__new_archive_scheduler_state"."backup_lease_owner" is not null and "__new_archive_scheduler_state"."backup_lease_expires_at" is not null)),
	CONSTRAINT "archive_scheduler_state_clock_health_check" CHECK("__new_archive_scheduler_state"."clock_health" in ('healthy', 'clock-blocked')),
	CONSTRAINT "archive_scheduler_state_observed_rollback_check" CHECK("__new_archive_scheduler_state"."observed_rollback_ms" is null or "__new_archive_scheduler_state"."observed_rollback_ms" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_archive_scheduler_state`("id", "revision", "backup_lease_owner", "backup_lease_expires_at", "last_backup_success_ms", "last_upload_success_ms", "last_reconcile_success_ms", "last_cleanup_success_ms", "last_motion_traversal_success_ms", "last_artifact_registration_success_ms", "last_plausible_wall_time_ms", "clock_health", "observed_rollback_ms") SELECT "id", "revision", "backup_lease_owner", "backup_lease_expires_at", "last_backup_success_ms", "last_upload_success_ms", "last_reconcile_success_ms", "last_cleanup_success_ms", "last_motion_traversal_success_ms", "last_artifact_registration_success_ms", "last_plausible_wall_time_ms", "clock_health", "observed_rollback_ms" FROM `archive_scheduler_state`;--> statement-breakpoint
DROP TABLE `archive_scheduler_state`;--> statement-breakpoint
ALTER TABLE `__new_archive_scheduler_state` RENAME TO `archive_scheduler_state`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_drive_motion_folder_reservations` (
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
	`revalidation_failure_streak` integer DEFAULT 0 NOT NULL,
	`next_revalidation_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`verified_at` integer,
	CONSTRAINT "drive_motion_folder_state_check" CHECK("__new_drive_motion_folder_reservations"."state" in ('reserved','verified','missing','detached','conflict','superseded')),
	CONSTRAINT "drive_motion_folder_slot_check" CHECK("__new_drive_motion_folder_reservations"."current_slot" is null or "__new_drive_motion_folder_reservations"."current_slot" = 1),
	CONSTRAINT "drive_motion_folder_revalidation_failure_streak_check" CHECK("__new_drive_motion_folder_reservations"."revalidation_failure_streak" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_drive_motion_folder_reservations`("id", "installation_id", "generation_id", "normalized_path", "level", "segment_name", "folder_id", "parent_folder_id", "state", "current_slot", "revision", "error_code", "revalidation_failure_streak", "next_revalidation_at", "created_at", "updated_at", "verified_at") SELECT "id", "installation_id", "generation_id", "normalized_path", "level", "segment_name", "folder_id", "parent_folder_id", "state", "current_slot", "revision", "error_code", "revalidation_failure_streak", "next_revalidation_at", "created_at", "updated_at", "verified_at" FROM `drive_motion_folder_reservations`;--> statement-breakpoint
DROP TABLE `drive_motion_folder_reservations`;--> statement-breakpoint
ALTER TABLE `__new_drive_motion_folder_reservations` RENAME TO `drive_motion_folder_reservations`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_drive_motion_folder_current_path` ON `drive_motion_folder_reservations` (`generation_id`,`normalized_path`) WHERE "drive_motion_folder_reservations"."current_slot" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_drive_motion_folder_id` ON `drive_motion_folder_reservations` (`folder_id`);--> statement-breakpoint
CREATE INDEX `idx_drive_motion_folder_current_health` ON `drive_motion_folder_reservations` (`generation_id`,`current_slot`,`state`,`next_revalidation_at`,`normalized_path`);
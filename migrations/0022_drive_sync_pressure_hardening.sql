ALTER TABLE `archive_scheduler_state` ADD `last_plausible_wall_time_ms` integer;--> statement-breakpoint
ALTER TABLE `archive_scheduler_state` ADD `clock_health` text DEFAULT 'healthy' NOT NULL;--> statement-breakpoint
ALTER TABLE `archive_scheduler_state` ADD `observed_rollback_ms` integer;--> statement-breakpoint
ALTER TABLE `drive_motion_folder_reservations` ADD `revalidation_failure_streak` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `drive_motion_folder_reservations` ADD `next_revalidation_at` integer;--> statement-breakpoint
CREATE INDEX `idx_drive_motion_folder_current_health` ON `drive_motion_folder_reservations` (`generation_id`,`current_slot`,`state`,`next_revalidation_at`,`normalized_path`);--> statement-breakpoint
CREATE INDEX `idx_archive_artifacts_admission_queue` ON `archive_artifacts` (`kind`,`state`,`admission_state`,`admission_next_at`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_archive_artifacts_motion_day` ON `archive_artifacts` (`motion_day_path`,`kind`,`state`);--> statement-breakpoint
CREATE INDEX `idx_archive_artifacts_registration_lookup` ON `archive_artifacts` (`installation_id`,`kind`,`source_identity`,`size`,`mtime_ns`);--> statement-breakpoint
CREATE INDEX `idx_drive_attempts_generation_queue` ON `drive_object_attempts` (`generation_id`,`state`,`next_attempt_at`,`retry_count`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_drive_attempts_artifact_generation_state` ON `drive_object_attempts` (`artifact_id`,`generation_id`,`state`);
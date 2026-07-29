DROP INDEX `idx_motion_not_uploaded`;--> statement-breakpoint
ALTER TABLE `motion_events` ADD `archive_artifact_id` text REFERENCES archive_artifacts(id);--> statement-breakpoint
CREATE INDEX `idx_motion_archive_artifact` ON `motion_events` (`archive_artifact_id`);--> statement-breakpoint
ALTER TABLE `motion_events` DROP COLUMN `uploaded_to_gdrive`;--> statement-breakpoint
ALTER TABLE `motion_events` DROP COLUMN `gdrive_file_id`;
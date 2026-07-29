DROP INDEX `idx_drive_object_attempts_queue`;--> statement-breakpoint
ALTER TABLE `drive_object_attempts` ADD `retry_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_drive_object_attempts_queue` ON `drive_object_attempts` (`state`,`next_attempt_at`,`retry_count`,`created_at`);
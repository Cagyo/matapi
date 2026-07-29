PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_archive_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`kind` text NOT NULL,
	`source_identity` text NOT NULL,
	`trusted_path` text NOT NULL,
	`relative_path` text NOT NULL,
	`size` integer NOT NULL,
	`mtime_ns` text NOT NULL,
	`source_time_ms` integer NOT NULL,
	`sha256` text NOT NULL,
	`source_fingerprint` text NOT NULL,
	`state` text NOT NULL,
	`current_verified_attempt_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`local_deleted_at` integer,
	`revision` integer NOT NULL,
	FOREIGN KEY (`current_verified_attempt_id`) REFERENCES `drive_object_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "archive_artifacts_kind_check" CHECK("__new_archive_artifacts"."kind" in ('motion_video', 'database_backup')),
	CONSTRAINT "archive_artifacts_state_check" CHECK("__new_archive_artifacts"."state" in ('stabilizing', 'pending', 'verified', 'local_missing', 'superseded')),
	CONSTRAINT "archive_artifacts_revision_check" CHECK("__new_archive_artifacts"."revision" >= 0),
	CONSTRAINT "archive_artifacts_size_check" CHECK("__new_archive_artifacts"."size" >= 0),
	CONSTRAINT "archive_artifacts_verified_check" CHECK(("__new_archive_artifacts"."state" = 'verified' and "__new_archive_artifacts"."current_verified_attempt_id" is not null) or ("__new_archive_artifacts"."state" != 'verified' and "__new_archive_artifacts"."current_verified_attempt_id" is null))
);
--> statement-breakpoint
INSERT INTO `__new_archive_artifacts`("id", "installation_id", "kind", "source_identity", "trusted_path", "relative_path", "size", "mtime_ns", "source_time_ms", "sha256", "source_fingerprint", "state", "current_verified_attempt_id", "created_at", "updated_at", "local_deleted_at", "revision") SELECT "id", "installation_id", "kind", "source_identity", "trusted_path", "relative_path", "size", "mtime_ns", "source_time_ms", "sha256", "source_fingerprint", "state", "current_verified_attempt_id", "created_at", "updated_at", "local_deleted_at", "revision" FROM `archive_artifacts`;--> statement-breakpoint
DROP TABLE `archive_artifacts`;--> statement-breakpoint
ALTER TABLE `__new_archive_artifacts` RENAME TO `archive_artifacts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_archive_artifacts_source_fingerprint` ON `archive_artifacts` (`source_fingerprint`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_archive_artifacts_current_verified_attempt` ON `archive_artifacts` (`current_verified_attempt_id`);--> statement-breakpoint
CREATE INDEX `idx_archive_artifacts_kind_created` ON `archive_artifacts` (`kind`,`created_at`);
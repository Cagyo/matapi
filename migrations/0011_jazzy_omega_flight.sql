CREATE TABLE `archive_artifacts` (
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
	CONSTRAINT "archive_artifacts_kind_check" CHECK("archive_artifacts"."kind" in ('motion_video', 'database_backup')),
	CONSTRAINT "archive_artifacts_state_check" CHECK("archive_artifacts"."state" in ('stabilizing', 'pending', 'verified', 'local_missing', 'superseded')),
	CONSTRAINT "archive_artifacts_revision_check" CHECK("archive_artifacts"."revision" >= 0),
	CONSTRAINT "archive_artifacts_size_check" CHECK("archive_artifacts"."size" >= 0),
	CONSTRAINT "archive_artifacts_verified_check" CHECK("archive_artifacts"."state" != 'verified' or "archive_artifacts"."current_verified_attempt_id" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_archive_artifacts_source_fingerprint` ON `archive_artifacts` (`source_fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_archive_artifacts_kind_created` ON `archive_artifacts` (`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `archive_scheduler_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`backup_lease_owner` text,
	`backup_lease_expires_at` integer,
	`last_backup_success_ms` integer,
	`last_upload_success_ms` integer,
	`last_reconcile_success_ms` integer,
	`last_cleanup_success_ms` integer,
	CONSTRAINT "archive_scheduler_state_singleton_check" CHECK("archive_scheduler_state"."id" = 1),
	CONSTRAINT "archive_scheduler_state_revision_check" CHECK("archive_scheduler_state"."revision" >= 0),
	CONSTRAINT "archive_scheduler_state_lease_check" CHECK(("archive_scheduler_state"."backup_lease_owner" is null and "archive_scheduler_state"."backup_lease_expires_at" is null) or ("archive_scheduler_state"."backup_lease_owner" is not null and "archive_scheduler_state"."backup_lease_expires_at" is not null))
);
--> statement-breakpoint
CREATE TABLE `drive_object_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`generation_id` text NOT NULL,
	`remote_file_id` text NOT NULL,
	`parent_id` text NOT NULL,
	`reserved_at` integer NOT NULL,
	`state` text NOT NULL,
	`revision` integer NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`session_ciphertext` text,
	`session_nonce` text,
	`session_auth_tag` text,
	`session_key_version` integer,
	`session_format_version` integer,
	`session_created_at` integer,
	`session_expires_at` integer,
	`confirmed_offset` integer,
	`error_code` text,
	`detached_reason` text,
	`missing_reason` text,
	`uploaded_at` integer,
	`verified_at` integer,
	`deleted_at` integer,
	`verified_name` text,
	`verified_mime_type` text,
	`verified_size` integer,
	`verified_sha256` text,
	`verified_md5` text,
	`verified_created_time` integer,
	`verified_head_revision_id` text,
	`verified_version` text,
	`verified_owned_by_me` integer,
	`verified_can_delete` integer,
	`verified_trashed` integer,
	`verified_app_properties` text,
	`verified_sharing` text,
	`verified_web_view_link` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `archive_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "drive_object_attempts_state_check" CHECK("drive_object_attempts"."state" in ('pending', 'uploading', 'retryable', 'verified', 'missing', 'detached', 'conflict', 'abandoned', 'deleted')),
	CONSTRAINT "drive_object_attempts_revision_check" CHECK("drive_object_attempts"."revision" >= 0),
	CONSTRAINT "drive_object_attempts_lease_check" CHECK(("drive_object_attempts"."lease_owner" is null and "drive_object_attempts"."lease_expires_at" is null) or ("drive_object_attempts"."lease_owner" is not null and "drive_object_attempts"."lease_expires_at" is not null)),
	CONSTRAINT "drive_object_attempts_session_check" CHECK(("drive_object_attempts"."session_ciphertext" is null and "drive_object_attempts"."session_nonce" is null and "drive_object_attempts"."session_auth_tag" is null and "drive_object_attempts"."session_key_version" is null and "drive_object_attempts"."session_format_version" is null and "drive_object_attempts"."session_created_at" is null and "drive_object_attempts"."session_expires_at" is null and "drive_object_attempts"."confirmed_offset" is null) or ("drive_object_attempts"."session_ciphertext" is not null and "drive_object_attempts"."session_nonce" is not null and "drive_object_attempts"."session_auth_tag" is not null and "drive_object_attempts"."session_key_version" is not null and "drive_object_attempts"."session_format_version" = 1 and "drive_object_attempts"."session_created_at" is not null and "drive_object_attempts"."session_expires_at" is not null and "drive_object_attempts"."confirmed_offset" is not null)),
	CONSTRAINT "drive_object_attempts_verified_check" CHECK("drive_object_attempts"."state" != 'verified' or ("drive_object_attempts"."verified_at" is not null and "drive_object_attempts"."verified_name" is not null and "drive_object_attempts"."verified_mime_type" is not null and "drive_object_attempts"."verified_size" is not null and "drive_object_attempts"."verified_sha256" is not null and "drive_object_attempts"."verified_created_time" is not null and "drive_object_attempts"."verified_head_revision_id" is not null and "drive_object_attempts"."verified_version" is not null and "drive_object_attempts"."verified_owned_by_me" is not null and "drive_object_attempts"."verified_can_delete" is not null and "drive_object_attempts"."verified_trashed" is not null and "drive_object_attempts"."verified_app_properties" is not null and "drive_object_attempts"."verified_sharing" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_drive_object_attempts_remote_file_id` ON `drive_object_attempts` (`remote_file_id`);--> statement-breakpoint
CREATE INDEX `idx_drive_object_attempts_queue` ON `drive_object_attempts` (`state`,`next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_drive_object_attempts_lease_expiry` ON `drive_object_attempts` (`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_drive_object_attempts_generation` ON `drive_object_attempts` (`generation_id`);--> statement-breakpoint
CREATE INDEX `idx_drive_object_attempts_artifact` ON `drive_object_attempts` (`artifact_id`,`created_at`);
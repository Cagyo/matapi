CREATE TABLE `feature_install_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`feature_name` text NOT NULL,
	`status` text NOT NULL,
	`active_slot` integer,
	`requested_by_user_id` integer NOT NULL,
	`requested_in_chat_id` integer NOT NULL,
	`workflow_receipt_id` text NOT NULL,
	`previous_installed` integer NOT NULL,
	`previous_enabled` integer NOT NULL,
	`restart_scope` text,
	`failure_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`feature_name`) REFERENCES `features`(`name`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "feature_install_jobs_status_check" CHECK("feature_install_jobs"."status" in ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "feature_install_jobs_active_slot_check" CHECK((
      ("feature_install_jobs"."status" in ('queued', 'running') and "feature_install_jobs"."active_slot" = 1)
      or ("feature_install_jobs"."status" in ('succeeded', 'failed') and "feature_install_jobs"."active_slot" is null)
    )),
	CONSTRAINT "feature_install_jobs_restart_scope_check" CHECK("feature_install_jobs"."restart_scope" is null or "feature_install_jobs"."restart_scope" in ('worker', 'supervisor', 'host'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_feature_install_jobs_active_slot` ON `feature_install_jobs` (`active_slot`);--> statement-breakpoint
CREATE INDEX `idx_feature_install_jobs_feature_time` ON `feature_install_jobs` (`feature_name`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_feature_install_jobs_receipt` ON `feature_install_jobs` (`workflow_receipt_id`);--> statement-breakpoint
ALTER TABLE `features` ADD `attention_reason` text;
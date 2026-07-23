PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_feature_install_jobs` (
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
	CONSTRAINT "feature_install_jobs_status_check" CHECK("__new_feature_install_jobs"."status" in ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "feature_install_jobs_active_slot_check" CHECK((
      ("__new_feature_install_jobs"."status" in ('queued', 'running') and "__new_feature_install_jobs"."active_slot" is 1)
      or ("__new_feature_install_jobs"."status" in ('succeeded', 'failed') and "__new_feature_install_jobs"."active_slot" is null)
    )),
	CONSTRAINT "feature_install_jobs_restart_scope_check" CHECK("__new_feature_install_jobs"."restart_scope" is null or "__new_feature_install_jobs"."restart_scope" in ('worker', 'supervisor', 'host'))
);
--> statement-breakpoint
INSERT INTO `__new_feature_install_jobs`("id", "feature_name", "status", "active_slot", "requested_by_user_id", "requested_in_chat_id", "workflow_receipt_id", "previous_installed", "previous_enabled", "restart_scope", "failure_code", "created_at", "updated_at") SELECT "id", "feature_name", "status", "active_slot", "requested_by_user_id", "requested_in_chat_id", "workflow_receipt_id", "previous_installed", "previous_enabled", "restart_scope", "failure_code", "created_at", "updated_at" FROM `feature_install_jobs`;--> statement-breakpoint
DROP TABLE `feature_install_jobs`;--> statement-breakpoint
ALTER TABLE `__new_feature_install_jobs` RENAME TO `feature_install_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_feature_install_jobs_active_slot` ON `feature_install_jobs` (`active_slot`);--> statement-breakpoint
CREATE INDEX `idx_feature_install_jobs_feature_time` ON `feature_install_jobs` (`feature_name`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_feature_install_jobs_receipt` ON `feature_install_jobs` (`workflow_receipt_id`);
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_live_view_settings_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`active_slot` integer,
	`expected_generation` integer NOT NULL,
	`candidate_settings` text NOT NULL,
	`requested_by_user_id` integer NOT NULL,
	`requested_in_chat_id` integer NOT NULL,
	`workflow_receipt_id` text NOT NULL,
	`failure_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`telegram_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "live_view_settings_jobs_id_check" CHECK(length("__new_live_view_settings_jobs"."id") = 16 and "__new_live_view_settings_jobs"."id" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "live_view_settings_jobs_status_check" CHECK("__new_live_view_settings_jobs"."status" in ('prepared', 'published', 'committed', 'restart-required', 'succeeded', 'failed')),
	CONSTRAINT "live_view_settings_jobs_generation_check" CHECK(typeof("__new_live_view_settings_jobs"."expected_generation") = 'integer' and "__new_live_view_settings_jobs"."expected_generation" between 0 and 9007199254740991),
	CONSTRAINT "live_view_settings_jobs_active_slot_check" CHECK((
      ("__new_live_view_settings_jobs"."status" in ('prepared', 'published', 'committed', 'restart-required') and "__new_live_view_settings_jobs"."active_slot" is 1)
      or ("__new_live_view_settings_jobs"."status" in ('succeeded', 'failed') and "__new_live_view_settings_jobs"."active_slot" is null)
    )),
	CONSTRAINT "live_view_settings_jobs_failure_code_check" CHECK("__new_live_view_settings_jobs"."failure_code" is null or "__new_live_view_settings_jobs"."failure_code" in (
      'request-invalid', 'stale-generation', 'settings-state-unsafe', 'policy-apply-failed',
      'service-unhealthy', 'rtsp-assets-absent', 'interrupted', 'helper-version-mismatch',
      'live-work-not-quiescent', 'request-publish-failed', 'unit-start-failed',
      'restart-dispatch-failed', 'restart-activation-timeout', 'dependency-unready'
    )),
	CONSTRAINT "live_view_settings_jobs_failure_state_check" CHECK((
      ("__new_live_view_settings_jobs"."status" in ('prepared', 'published', 'committed', 'succeeded') and "__new_live_view_settings_jobs"."failure_code" is null)
      or ("__new_live_view_settings_jobs"."status" = 'restart-required' and "__new_live_view_settings_jobs"."failure_code" in ('restart-dispatch-failed', 'restart-activation-timeout'))
      or ("__new_live_view_settings_jobs"."status" = 'failed' and "__new_live_view_settings_jobs"."failure_code" is not null)
    ))
);
--> statement-breakpoint
INSERT INTO `__new_live_view_settings_jobs`("id", "status", "active_slot", "expected_generation", "candidate_settings", "requested_by_user_id", "requested_in_chat_id", "workflow_receipt_id", "failure_code", "created_at", "updated_at") SELECT "id", "status", "active_slot", "expected_generation", "candidate_settings", "requested_by_user_id", "requested_in_chat_id", "workflow_receipt_id", "failure_code", "created_at", "updated_at" FROM `live_view_settings_jobs`;--> statement-breakpoint
DROP TABLE `live_view_settings_jobs`;--> statement-breakpoint
ALTER TABLE `__new_live_view_settings_jobs` RENAME TO `live_view_settings_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_live_view_settings_jobs_active_slot` ON `live_view_settings_jobs` (`active_slot`);--> statement-breakpoint
CREATE INDEX `idx_live_view_settings_jobs_receipt` ON `live_view_settings_jobs` (`workflow_receipt_id`);
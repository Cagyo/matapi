CREATE TABLE `live_view_settings_jobs` (
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
	CONSTRAINT "live_view_settings_jobs_status_check" CHECK("live_view_settings_jobs"."status" in ('prepared', 'published', 'committed', 'restart-required', 'succeeded', 'failed')),
	CONSTRAINT "live_view_settings_jobs_generation_check" CHECK("live_view_settings_jobs"."expected_generation" >= 0),
	CONSTRAINT "live_view_settings_jobs_active_slot_check" CHECK((
      ("live_view_settings_jobs"."status" in ('prepared', 'published', 'committed', 'restart-required') and "live_view_settings_jobs"."active_slot" is 1)
      or ("live_view_settings_jobs"."status" in ('succeeded', 'failed') and "live_view_settings_jobs"."active_slot" is null)
    )),
	CONSTRAINT "live_view_settings_jobs_failure_code_check" CHECK("live_view_settings_jobs"."failure_code" is null or "live_view_settings_jobs"."failure_code" in (
      'request-invalid', 'stale-generation', 'settings-state-unsafe', 'policy-apply-failed',
      'service-unhealthy', 'rtsp-assets-absent', 'interrupted', 'helper-version-mismatch',
      'live-work-not-quiescent', 'request-publish-failed', 'unit-start-failed',
      'restart-dispatch-failed', 'restart-activation-timeout', 'dependency-unready'
    )),
	CONSTRAINT "live_view_settings_jobs_failure_state_check" CHECK((
      ("live_view_settings_jobs"."status" in ('prepared', 'published', 'committed', 'succeeded') and "live_view_settings_jobs"."failure_code" is null)
      or ("live_view_settings_jobs"."status" = 'restart-required' and "live_view_settings_jobs"."failure_code" in ('restart-dispatch-failed', 'restart-activation-timeout'))
      or ("live_view_settings_jobs"."status" = 'failed' and "live_view_settings_jobs"."failure_code" is not null)
    ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_live_view_settings_jobs_active_slot` ON `live_view_settings_jobs` (`active_slot`);--> statement-breakpoint
CREATE INDEX `idx_live_view_settings_jobs_receipt` ON `live_view_settings_jobs` (`workflow_receipt_id`);
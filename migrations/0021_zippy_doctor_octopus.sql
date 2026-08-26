CREATE TABLE `telegram_camera_source_prompts` (
	`user_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`receipt_id` text NOT NULL,
	`prompt_message_id` integer NOT NULL,
	`reply_message_id` integer,
	`phase` text NOT NULL,
	`operation` text NOT NULL,
	`camera_id` text,
	`display_name` text,
	`expected_revision` integer,
	`status` text NOT NULL,
	`deletion_failed` integer DEFAULT false NOT NULL,
	`expires_at` integer NOT NULL,
	`retain_until` integer,
	PRIMARY KEY(`user_id`, `chat_id`, `receipt_id`, `prompt_message_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`telegram_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "telegram_camera_source_prompts_identity_check" CHECK("telegram_camera_source_prompts"."user_id" > 0 and "telegram_camera_source_prompts"."chat_id" > 0),
	CONSTRAINT "telegram_camera_source_prompts_receipt_check" CHECK(length("telegram_camera_source_prompts"."receipt_id") = 16),
	CONSTRAINT "telegram_camera_source_prompts_prompt_message_check" CHECK("telegram_camera_source_prompts"."prompt_message_id" > 0),
	CONSTRAINT "telegram_camera_source_prompts_reply_message_check" CHECK("telegram_camera_source_prompts"."reply_message_id" is null or "telegram_camera_source_prompts"."reply_message_id" > 0),
	CONSTRAINT "telegram_camera_source_prompts_phase_check" CHECK("telegram_camera_source_prompts"."phase" in ('name', 'credential')),
	CONSTRAINT "telegram_camera_source_prompts_operation_check" CHECK("telegram_camera_source_prompts"."operation" in ('create', 'attach', 'replace')),
	CONSTRAINT "telegram_camera_source_prompts_status_check" CHECK("telegram_camera_source_prompts"."status" in ('pending', 'running', 'consumed', 'expired')),
	CONSTRAINT "telegram_camera_source_prompts_deletion_failed_check" CHECK("telegram_camera_source_prompts"."deletion_failed" in (0, 1)),
	CONSTRAINT "telegram_camera_source_prompts_expected_revision_check" CHECK("telegram_camera_source_prompts"."expected_revision" is null or "telegram_camera_source_prompts"."expected_revision" >= 0),
	CONSTRAINT "telegram_camera_source_prompts_selection_check" CHECK("telegram_camera_source_prompts"."phase" != 'credential' or "telegram_camera_source_prompts"."camera_id" is not null or "telegram_camera_source_prompts"."display_name" is not null),
	CONSTRAINT "telegram_camera_source_prompts_retention_check" CHECK((
      ("telegram_camera_source_prompts"."status" in ('pending', 'running') and "telegram_camera_source_prompts"."retain_until" is null)
      or
      ("telegram_camera_source_prompts"."status" in ('consumed', 'expired') and "telegram_camera_source_prompts"."phase" = 'credential' and "telegram_camera_source_prompts"."retain_until" is not null)
    ))
);
--> statement-breakpoint
CREATE INDEX `idx_telegram_camera_source_prompts_live` ON `telegram_camera_source_prompts` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_telegram_camera_source_prompts_retention` ON `telegram_camera_source_prompts` (`user_id`,`retain_until`);
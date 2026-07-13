CREATE TABLE `notification_pause_receipts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`previous_paused_until` integer,
	`applied_paused_until` integer NOT NULL,
	`expected_revision` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`telegram_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_notification_pause_receipts_user_id` ON `notification_pause_receipts` (`user_id`,`id`);--> statement-breakpoint
ALTER TABLE `users` ADD `non_critical_paused_until` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `notification_pause_revision` integer DEFAULT 0 NOT NULL;
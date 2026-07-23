PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_home_action_receipts` (
	`user_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`current_slot` integer DEFAULT 1,
	`session_token` text,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `chat_id`, `kind`, `id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`telegram_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_home_action_receipts`("user_id", "chat_id", "kind", "id", "current_slot", "session_token", "status", "payload", "expires_at", "updated_at") SELECT "user_id", "chat_id", "kind", "id", "current_slot", "session_token", "status", "payload", "expires_at", "updated_at" FROM `home_action_receipts`;--> statement-breakpoint
DROP TABLE `home_action_receipts`;--> statement-breakpoint
ALTER TABLE `__new_home_action_receipts` RENAME TO `home_action_receipts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_home_action_receipts_current` ON `home_action_receipts` (`user_id`,`chat_id`,`kind`,`current_slot`);--> statement-breakpoint
CREATE INDEX `idx_home_action_receipts_identity` ON `home_action_receipts` (`user_id`,`chat_id`,`kind`,`id`);
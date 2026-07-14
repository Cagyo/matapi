CREATE TABLE `home_action_receipts` (
	`user_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`session_token` text,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `chat_id`, `kind`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`telegram_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `home_sessions` ADD `active_view_payload` text;--> statement-breakpoint
ALTER TABLE `home_sessions` ADD `pending_view_payload` text;
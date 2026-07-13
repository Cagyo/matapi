CREATE TABLE `home_sessions` (
	`user_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`active_message_id` integer,
	`active_token` text,
	`active_revision` integer,
	`active_view` text,
	`active_sensor_page` integer,
	`active_checking` integer,
	`pending_kind` text,
	`pending_message_id` integer,
	`pending_token` text,
	`pending_revision` integer,
	`pending_view` text,
	`pending_sensor_page` integer,
	`pending_checking` integer,
	`pending_expires_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `chat_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`telegram_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_home_sessions_pending_expiry` ON `home_sessions` (`pending_expires_at`);
CREATE TABLE `ota_operation_workflows` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`operation_kind` text NOT NULL,
	`user_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	`workflow_receipt_id` text NOT NULL,
	`authorized_at` integer NOT NULL,
	`delivery_lease_id` text,
	`delivery_lease_until` integer,
	`delivered_at` integer,
	`acknowledged_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`telegram_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ota_operation_workflows_owner` ON `ota_operation_workflows` (`user_id`,`chat_id`,`workflow_receipt_id`);--> statement-breakpoint
CREATE INDEX `idx_ota_operation_workflows_delivery` ON `ota_operation_workflows` (`acknowledged_at`,`delivery_lease_until`);
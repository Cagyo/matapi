CREATE TABLE `drive_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer NOT NULL,
	`client_id_hash` text NOT NULL,
	`client_envelope` text,
	`token_envelope` text,
	`current_slot` integer,
	`staged_slot` integer,
	`permission_id` text,
	`email` text,
	`display_name` text,
	`root_folder_id` text,
	`motion_folder_id` text,
	`backups_folder_id` text,
	`admin_user_id` integer,
	`chat_id` integer,
	`workflow_receipt_id` text,
	`workflow_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`activated_at` integer,
	`retired_at` integer,
	`error_code` text,
	`alert_cooldowns` text,
	`quota_reclamation_started_at` integer,
	`quota_reclaimed_at` integer,
	`quota_reclamation_error_code` text,
	CONSTRAINT "drive_connections_status_check" CHECK("drive_connections"."status" in ('staged', 'active', 'reauth_required', 'retiring', 'retired_unmanaged', 'disconnecting', 'disconnected')),
	CONSTRAINT "drive_connections_revision_check" CHECK("drive_connections"."revision" >= 0),
	CONSTRAINT "drive_connections_current_slot_check" CHECK("drive_connections"."current_slot" is null or "drive_connections"."current_slot" = 1),
	CONSTRAINT "drive_connections_staged_slot_check" CHECK("drive_connections"."staged_slot" is null or "drive_connections"."staged_slot" = 1),
	CONSTRAINT "drive_connections_slot_status_check" CHECK((
      ("drive_connections"."status" = 'staged' and "drive_connections"."staged_slot" = 1 and "drive_connections"."current_slot" is null)
      or
      ("drive_connections"."status" in ('active', 'reauth_required') and "drive_connections"."current_slot" = 1 and "drive_connections"."staged_slot" is null)
      or
      ("drive_connections"."status" in ('retiring', 'retired_unmanaged', 'disconnecting', 'disconnected') and "drive_connections"."current_slot" is null and "drive_connections"."staged_slot" is null)
    ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_drive_connections_current_slot` ON `drive_connections` (`current_slot`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_drive_connections_staged_slot` ON `drive_connections` (`staged_slot`);--> statement-breakpoint
CREATE INDEX `idx_drive_connections_staged_expiry` ON `drive_connections` (`staged_slot`,`workflow_expires_at`);
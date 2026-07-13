CREATE TABLE `camera_live_credentials` (
	`camera_id` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`nonce` text NOT NULL,
	`auth_tag` text NOT NULL,
	`key_version` integer NOT NULL,
	FOREIGN KEY (`camera_id`) REFERENCES `camera_live_sources`(`camera_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `camera_live_sources` (
	`camera_id` text PRIMARY KEY NOT NULL,
	`normalized_url` text NOT NULL,
	`settings` text NOT NULL,
	`ready` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`camera_id`) REFERENCES `cameras`(`id`) ON UPDATE no action ON DELETE cascade
);

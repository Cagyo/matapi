ALTER TABLE `feature_install_jobs` ADD `operation` text DEFAULT 'install' NOT NULL;--> statement-breakpoint
ALTER TABLE `feature_install_jobs` ADD `restart_dispatch_identity` text;
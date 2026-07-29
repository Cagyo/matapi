-- Custom SQL migration file, put your code below! --
CREATE TRIGGER `archive_artifacts_current_verified_attempt_insert_guard`
BEFORE INSERT ON `archive_artifacts`
FOR EACH ROW WHEN NEW.`current_verified_attempt_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `drive_object_attempts`
    WHERE `id` = NEW.`current_verified_attempt_id`
      AND `artifact_id` = NEW.`id`
      AND `state` = 'verified'
  )
BEGIN
  SELECT RAISE(ABORT, 'current verified attempt must belong to this artifact and be verified');
END;--> statement-breakpoint
CREATE TRIGGER `archive_artifacts_current_verified_attempt_update_guard`
BEFORE UPDATE OF `state`, `current_verified_attempt_id` ON `archive_artifacts`
FOR EACH ROW WHEN NEW.`current_verified_attempt_id` IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `drive_object_attempts`
    WHERE `id` = NEW.`current_verified_attempt_id`
      AND `artifact_id` = NEW.`id`
      AND `state` = 'verified'
  )
BEGIN
  SELECT RAISE(ABORT, 'current verified attempt must belong to this artifact and be verified');
END;--> statement-breakpoint
CREATE TRIGGER `drive_object_attempts_current_verified_state_guard`
BEFORE UPDATE OF `artifact_id`, `state` ON `drive_object_attempts`
FOR EACH ROW WHEN (NEW.`artifact_id` != OLD.`artifact_id` OR NEW.`state` != 'verified')
  AND EXISTS (
    SELECT 1 FROM `archive_artifacts`
    WHERE `current_verified_attempt_id` = OLD.`id`
  )
BEGIN
  SELECT RAISE(ABORT, 'current verified attempt cannot leave its artifact or verified state');
END;--> statement-breakpoint
CREATE TRIGGER `drive_object_attempts_current_verified_delete_guard`
BEFORE DELETE ON `drive_object_attempts`
FOR EACH ROW WHEN EXISTS (
  SELECT 1 FROM `archive_artifacts`
  WHERE `current_verified_attempt_id` = OLD.`id`
)
BEGIN
  SELECT RAISE(ABORT, 'current verified attempt cannot be deleted');
END;

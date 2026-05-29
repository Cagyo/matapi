export const OTA = Symbol('OTA');

export interface UpdateCheck {
  hasUpdates: boolean;
  localCommit: string;
  remoteCommit: string;
}

/**
 * Out-of-the-air update operations (spec 13 / spec 24). The adapter
 * shells out to `scripts/update.sh`, which owns the lockfile, git tag,
 * install, migrate, pm2 restart and health-check sequence.
 */
export interface OtaPort {
  /** `true` when an update is currently being applied. */
  isLocked(): Promise<boolean>;
  /** `git fetch` + commit comparison. Does not mutate the working copy. */
  checkForUpdates(): Promise<UpdateCheck>;
  /**
   * Spawn the detached update script. Resolves once the child has been
   * spawned; the script will pm2-restart this process shortly after.
   */
  startUpdate(): Promise<void>;
  /**
   * Spawn the detached rollback script. Same behaviour as `startUpdate`.
   * Rejects with `NoRollbackTagError` when no `rollback-*` tag exists.
   */
  startRollback(): Promise<void>;
}

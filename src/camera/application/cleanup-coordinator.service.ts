import { Injectable, Logger } from '@nestjs/common';
import { CleanupDriveUseCase } from './cleanup-drive.use-case';
import { CleanupLocalStorageUseCase } from './cleanup-local-storage.use-case';

export type CleanupTarget = 'local' | 'drive' | 'both';

export interface CleanupResult {
  executed: boolean;
  thresholdUsed: number;
}

/**
 * Coordinates storage cleanups across local disk and Google Drive (spec 21).
 *
 * Enforces an atomic execution lock so that background interval cleanups and
 * manual admin triggers (`/clean` or dashboard buttons) never run concurrently,
 * preventing SQLite busy timeouts and rclone file collisions.
 */
@Injectable()
export class CleanupCoordinatorService {
  private readonly logger = new Logger(CleanupCoordinatorService.name);
  private activeTarget: CleanupTarget | null = null;

  constructor(
    private readonly cleanupLocal: CleanupLocalStorageUseCase,
    private readonly cleanupDrive: CleanupDriveUseCase,
  ) {}

  /** Whether any storage cleanup is currently executing. */
  isCleaning(): boolean {
    return this.activeTarget !== null;
  }

  /** The target currently being cleaned (`local`, `drive`, `both`), or `null`. */
  getActiveTarget(): CleanupTarget | null {
    return this.activeTarget;
  }

  /**
   * Execute cleanup for the given target, optionally overriding the trigger threshold.
   * If another cleanup is already running, returns `{ executed: false, thresholdUsed: 0 }`.
   */
  async runCleanup(
    target: CleanupTarget,
    customThreshold?: number,
  ): Promise<CleanupResult> {
    if (this.activeTarget !== null) {
      this.logger.warn(
        `Skipping cleanup (${target}) — another cleanup (${this.activeTarget}) is already in progress`,
      );
      return { executed: false, thresholdUsed: customThreshold ?? 0 };
    }

    this.activeTarget = target;
    let thresholdUsed = customThreshold ?? 0;

    try {
      if (target === 'local' || target === 'both') {
        const res = await this.cleanupLocal.execute(customThreshold);
        if (res?.thresholdUsed && thresholdUsed === 0) {
          thresholdUsed = res.thresholdUsed;
        }
      }
      if (target === 'drive' || target === 'both') {
        const res = await this.cleanupDrive.execute(customThreshold);
        if (res?.thresholdUsed && thresholdUsed === 0) {
          thresholdUsed = res.thresholdUsed;
        }
      }
      return { executed: true, thresholdUsed };
    } catch (err) {
      this.logger.error(
        `Cleanup (${target}) failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      throw err;
    } finally {
      this.activeTarget = null;
    }
  }
}

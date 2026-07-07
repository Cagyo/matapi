import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { CAMERA_MODE, CameraMode } from '../camera.tokens';
import { BackupUploadUseCase } from './backup-upload.use-case';
import { CleanupCoordinatorService } from './cleanup-coordinator.service';
import { UploadMotionUseCase } from './upload-motion.use-case';

const UPLOAD_INTERVAL_MS = 2 * 60 * 1000;
const LOCAL_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DRIVE_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BACKUP_CRON = '0 3 * * *';

/**
 * Drive sync scheduler (spec 21). Drives the four maintenance loops on timers
 * and a daily cron. Each loop is gated to `real` mode and guarded against
 * re-entrancy, so a slow run never overlaps the next tick. The scheduler is a
 * thin trigger; all behaviour lives in the use cases and coordinator.
 */
@Injectable()
export class DriveSyncScheduler {
  private readonly logger = new Logger(DriveSyncScheduler.name);
  private readonly running = new Set<string>();

  constructor(
    @Inject(CAMERA_MODE) private readonly mode: CameraMode,
    private readonly uploadMotion: UploadMotionUseCase,
    private readonly coordinator: CleanupCoordinatorService,
    private readonly backupUpload: BackupUploadUseCase,
  ) {}

  @Interval('drive-upload', UPLOAD_INTERVAL_MS)
  uploadTick(): void {
    void this.run('upload', () => this.uploadMotion.execute());
  }

  @Interval('local-cleanup', LOCAL_CLEANUP_INTERVAL_MS)
  localCleanupTick(): void {
    void this.run('local-cleanup', async () => {
      await this.coordinator.runCleanup('local');
    });
  }

  @Interval('drive-cleanup', DRIVE_CLEANUP_INTERVAL_MS)
  driveCleanupTick(): void {
    void this.run('drive-cleanup', async () => {
      await this.coordinator.runCleanup('drive');
    });
  }

  @Cron(process.env.BACKUP_CRON || DEFAULT_BACKUP_CRON, { name: 'db-backup' })
  backupTick(): void {
    void this.run('backup', () => this.backupUpload.execute());
  }

  private async run(name: string, task: () => Promise<void>): Promise<void> {
    if (this.mode !== 'real') return;
    if (this.running.has(name)) {
      this.logger.debug(`Skipping ${name} — previous run still in progress`);
      return;
    }
    this.running.add(name);
    try {
      await task();
    } catch (err) {
      this.logger.error(`${name} failed: ${(err as Error).message}`);
    } finally {
      this.running.delete(name);
    }
  }
}

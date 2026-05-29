import { Inject, Injectable, Logger } from '@nestjs/common';
import { format } from 'date-fns';
import { DB_BACKUP, DbBackupPort } from '../domain/ports/db-backup.port';
import { DRIVE_SYNC, DriveSyncPort } from '../domain/ports/drive-sync.port';

/** Drive backups kept; older are pruned (spec 21). */
const BACKUP_RETENTION_DAYS = 7;

/**
 * Daily database backup upload (spec 21). Produces a fresh local SQLite backup,
 * uploads it to the Drive backups folder as `worker-YYYY-MM-DD.db`, then prunes
 * Drive backups older than a week. Skipped when `BACKUP_TO_GDRIVE=false`.
 */
@Injectable()
export class BackupUploadUseCase {
  private readonly logger = new Logger(BackupUploadUseCase.name);

  constructor(
    @Inject(DB_BACKUP) private readonly dbBackup: DbBackupPort,
    @Inject(DRIVE_SYNC) private readonly drive: DriveSyncPort,
  ) {}

  async execute(): Promise<void> {
    if (process.env.BACKUP_TO_GDRIVE === 'false') {
      this.logger.debug('BACKUP_TO_GDRIVE=false — skipping Drive backup upload');
      return;
    }

    const localPath = await this.dbBackup.createLocalBackup();
    const remoteName = `worker-${format(new Date(), 'yyyy-MM-dd')}.db`;
    await this.drive.uploadBackup(localPath, remoteName);
    await this.drive.pruneBackups(BACKUP_RETENTION_DAYS);
    this.logger.log(`DB backup uploaded to Drive as ${remoteName}`);
  }
}

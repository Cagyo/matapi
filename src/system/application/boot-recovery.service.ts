import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbRecovery } from '../../database/integrity';
import { DatabaseRecoveryState } from '../../database/database-recovery.state';
import {
  CLOCK_SYNC_PROBE,
  ClockSyncProbePort,
} from '../domain/ports/clock-sync.port';

/**
 * Path-free marker for an archive boot failure contained here. The `catch`
 * binds nothing, so this line cannot leak an errno, a message, or a scan
 * path no matter how the archive context is refactored — safety here does
 * not rest on any behaviour outside this file. (The errno stays discoverable
 * in the journal: the archive context logs its own discriminated code from
 * `onApplicationBootstrap`, which Nest fires first.)
 */
const ARCHIVE_OPERATION_FAILED = 'ARCHIVE_OPERATION_FAILED';

/** Diagnostics gathered during boot recovery, surfaced to the online notice. */
export interface BootDiagnostics {
  dbRecovery: DbRecovery;
  clockSynchronized: boolean;
  /**
   * `false` only when a registered archive recovery hook actually rejected.
   * A boot with no hook registered reports `true`: there is no failure to
   * report, and warning about an archive that was never wired would cry wolf
   * on every boot of an archive-less configuration.
   */
  archiveRecovered: boolean;
}

/**
 * Boot recovery coordinator (spec 23 — Boot Recovery). Logs the clock
 * synchronisation state and surfaces the database recovery outcome recorded by
 * the SQLite factory. Delivery of the "system online" notice is left to the
 * interface layer, which owns the notifier seam.
 */
@Injectable()
export class BootRecoveryService {
  private readonly logger = new Logger(BootRecoveryService.name);
  private archiveRecovery: (() => Promise<void>) | null = null;

  constructor(
    @Inject(CLOCK_SYNC_PROBE) private readonly clockSync: ClockSyncProbePort,
    private readonly recoveryState: DatabaseRecoveryState,
  ) {}

  /** Registered by ArchiveModule without introducing a System→Archive cycle. */
  registerArchiveRecovery(recover: () => Promise<void>): void {
    this.archiveRecovery = recover;
  }

  async run(): Promise<BootDiagnostics> {
    const archiveRecovered = await this.recoverArchive();
    const dbRecovery = this.recoveryState.recovery;
    if (dbRecovery === 'restored_from_backup') {
      this.logger.warn('Database was restored from local backup after corruption');
    } else if (dbRecovery === 'recreated_empty') {
      this.logger.warn('Database was recreated empty after corruption — config import needed');
    }

    const clock = await this.clockSync.probe();
    if (clock.synchronized) {
      this.logger.log(
        clock.offsetMs === null
          ? 'Clock synchronized'
          : `Clock synchronized, offset ${clock.offsetMs}ms`,
      );
    } else {
      this.logger.warn('Clock not synchronized — early timestamps may drift');
    }

    return { dbRecovery, clockSynchronized: clock.synchronized, archiveRecovered };
  }

  /**
   * Archive recovery used to run unguarded as the first statement of `run()`,
   * so an archive failure suppressed the "system online" broadcast — the one
   * channel that should have reported the outage. Contain it: the remaining
   * diagnostics still run and the outcome reaches the operator.
   */
  private async recoverArchive(): Promise<boolean> {
    const recover = this.archiveRecovery;
    if (recover === null) return true;
    try {
      await recover();
      return true;
    } catch {
      // Deliberately not "Archive boot recovery failed": the archive context
      // logs that line, with its own discriminated code, for this same single
      // rejection. A shared prefix made one fault read as two.
      this.logger.error(
        `Continuing boot diagnostics after a contained archive failure: ${ARCHIVE_OPERATION_FAILED}`,
      );
      return false;
    }
  }
}

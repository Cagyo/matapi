import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbRecovery } from '../../database/integrity';
import { DatabaseRecoveryState } from '../../database/database-recovery.state';
import {
  CLOCK_SYNC_PROBE,
  ClockSyncProbePort,
} from '../domain/ports/clock-sync.port';

/** Diagnostics gathered during boot recovery, surfaced to the online notice. */
export interface BootDiagnostics {
  dbRecovery: DbRecovery;
  clockSynchronized: boolean;
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

  constructor(
    @Inject(CLOCK_SYNC_PROBE) private readonly clockSync: ClockSyncProbePort,
    private readonly recoveryState: DatabaseRecoveryState,
  ) {}

  async run(): Promise<BootDiagnostics> {
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

    return { dbRecovery, clockSynchronized: clock.synchronized };
  }
}

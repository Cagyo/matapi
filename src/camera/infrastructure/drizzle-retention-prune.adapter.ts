import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, isNotNull, lt } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { events, sensorLogs } from '../../database/schema';
import { RetentionPrunePort } from '../domain/ports/retention-prune.port';

/**
 * Production `RetentionPrunePort` (spec 21 — emergency disk cleanup). Deletes
 * already-sent events and old sensor logs. Only invoked when the disk is at
 * `DISK_EMERGENCY_PERCENT`; unsent events are preserved so nothing queued for
 * delivery is lost.
 */
@Injectable()
export class DrizzleRetentionPruneAdapter implements RetentionPrunePort {
  private readonly logger = new Logger(DrizzleRetentionPruneAdapter.name);

  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async pruneEventsOlderThan(cutoff: Date): Promise<number> {
    const result = this.db
      .delete(events)
      .where(and(isNotNull(events.sentAt), lt(events.createdAt, cutoff)))
      .run();
    this.logger.warn(`Emergency prune: ${result.changes} sent events removed`);
    return result.changes;
  }

  async pruneSensorLogsOlderThan(cutoff: Date): Promise<number> {
    const result = this.db
      .delete(sensorLogs)
      .where(lt(sensorLogs.timestamp, cutoff))
      .run();
    this.logger.warn(`Emergency prune: ${result.changes} sensor logs removed`);
    return result.changes;
  }
}

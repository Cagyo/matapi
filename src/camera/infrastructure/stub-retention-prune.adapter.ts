import { Injectable } from '@nestjs/common';
import { RetentionPrunePort } from '../domain/ports/retention-prune.port';

/** Dev/test `RetentionPrunePort`. Records calls; deletes nothing. */
@Injectable()
export class StubRetentionPruneAdapter implements RetentionPrunePort {
  async pruneEventsOlderThan(): Promise<number> {
    return 0;
  }

  async pruneSensorLogsOlderThan(): Promise<number> {
    return 0;
  }
}

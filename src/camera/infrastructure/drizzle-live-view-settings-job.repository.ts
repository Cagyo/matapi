import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { liveViewSettingsJobs } from '../../database/schema';
import {
  createLiveViewSettingsJob,
  type LiveViewSettingsJob,
  type LiveViewSettingsJobFailureCode,
  type LiveViewSettingsJobStatus,
} from '../domain/live-view-settings-job';
import type { LiveViewSettingsJobRepositoryPort } from '../domain/ports/live-view-settings-job-repository.port';

type JobRow = typeof liveViewSettingsJobs.$inferSelect;
type JobWriter = Pick<AppDatabase, 'select' | 'update'>;

@Injectable()
export class DrizzleLiveViewSettingsJobRepository implements LiveViewSettingsJobRepositoryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async findById(id: string): Promise<LiveViewSettingsJob | null> {
    const row = this.db.select().from(liveViewSettingsJobs)
      .where(eq(liveViewSettingsJobs.id, id)).get();
    return row ? toJob(row) : null;
  }

  async findActive(): Promise<LiveViewSettingsJob | null> {
    const row = this.db.select().from(liveViewSettingsJobs)
      .where(eq(liveViewSettingsJobs.activeSlot, 1)).get();
    return row ? toJob(row) : null;
  }

  async markPublished(id: string, now: Date): Promise<LiveViewSettingsJob> {
    return this.transition(id, ['prepared'], 'published', null, now);
  }

  async markCommitted(id: string, now: Date): Promise<LiveViewSettingsJob> {
    return this.transition(id, ['published'], 'committed', null, now);
  }

  async markRestartRequired(
    id: string,
    code: 'restart-dispatch-failed' | 'restart-activation-timeout',
    now: Date,
  ): Promise<LiveViewSettingsJob> {
    return this.transition(id, ['committed'], 'restart-required', code, now);
  }

  async terminalizeSuccess(id: string, now: Date): Promise<LiveViewSettingsJob> {
    return this.transition(id, ['committed', 'restart-required'], 'succeeded', null, now);
  }

  async terminalizeFailure(
    id: string,
    code: LiveViewSettingsJobFailureCode,
    now: Date,
  ): Promise<LiveViewSettingsJob> {
    return this.transition(id, ['prepared', 'published'], 'failed', code, now);
  }

  private transition(
    id: string,
    allowed: readonly LiveViewSettingsJobStatus[],
    status: LiveViewSettingsJobStatus,
    failureCode: LiveViewSettingsJobFailureCode | null,
    now: Date,
  ): LiveViewSettingsJob {
    return this.immediate((tx) => {
      const [row] = tx.update(liveViewSettingsJobs)
        .set({
          status,
          activeSlot: status === 'succeeded' || status === 'failed' ? null : 1,
          failureCode,
          updatedAt: now,
        })
        .where(and(
          eq(liveViewSettingsJobs.id, id),
          eq(liveViewSettingsJobs.activeSlot, 1),
          inArray(liveViewSettingsJobs.status, [...allowed]),
        ))
        .returning()
        .all();
      if (!row) throw stateChanged(id);
      return toJob(row);
    });
  }

  private immediate<T>(operation: (tx: JobWriter) => T): T {
    return this.db.transaction((tx) => operation(tx), { behavior: 'immediate' });
  }
}

function stateChanged(id: string): RangeError {
  return new RangeError(`Live view settings job '${id}' state changed`);
}

function toJob(row: JobRow): LiveViewSettingsJob {
  return createLiveViewSettingsJob({
    id: row.id,
    status: row.status,
    expectedGeneration: row.expectedGeneration,
    candidateSettings: row.candidateSettings,
    failureCode: row.failureCode,
  });
}

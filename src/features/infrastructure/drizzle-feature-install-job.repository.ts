import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { featureInstallJobs, features } from '../../database/schema';
import { FeatureInstallBusyError } from '../domain/errors/feature-install-busy.error';
import { FeatureStateChangedError } from '../domain/errors/feature-state-changed.error';
import type {
  CreateFeatureInstallJob,
  FeatureAttentionReason,
  FeatureInstallFailureCode,
  FeatureInstallJob,
  FeatureInstallJobStatus,
  FeatureInstallOperation,
  ManageableFeatureName,
  RestartScope,
} from '../domain/manageable-feature';
import type { FeatureInstallJobRepositoryPort } from '../domain/ports/feature-install-job.repository.port';

type JobRow = typeof featureInstallJobs.$inferSelect;
type JobWriter = Pick<AppDatabase, 'insert' | 'select' | 'update'>;

/** Durable SQLite implementation; queued creation and terminalization take an immediate write lock. */
@Injectable()
export class DrizzleFeatureInstallJobRepository implements FeatureInstallJobRepositoryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async createQueued(input: CreateFeatureInstallJob): Promise<FeatureInstallJob> {
    return this.immediate((tx) => {
      const feature = tx.select().from(features).where(eq(features.name, input.feature)).get();
      if (!feature
        || (feature.installed ?? false) !== input.expected.installed
        || (feature.enabled ?? false) !== input.expected.enabled) {
        throw new FeatureStateChangedError(input.feature);
      }

      try {
        const [row] = tx.insert(featureInstallJobs).values({
          id: input.id,
          featureName: input.feature,
          status: 'queued',
          activeSlot: 1,
          operation: input.operation,
          requestedByUserId: input.requestedByUserId,
          requestedInChatId: input.requestedInChatId,
          workflowReceiptId: input.workflowReceiptId,
          previousInstalled: feature.installed ?? false,
          previousEnabled: feature.enabled ?? false,
          restartScope: null,
          restartDispatchIdentity: null,
          failureCode: null,
          createdAt: input.now,
          updatedAt: input.now,
        }).returning().all();
        return toJob(row);
      } catch (error) {
        if (isActiveSlotViolation(error)) {
          const active = tx.select({ featureName: featureInstallJobs.featureName })
            .from(featureInstallJobs)
            .where(eq(featureInstallJobs.activeSlot, 1))
            .get();
          throw new FeatureInstallBusyError((active?.featureName ?? input.feature) as ManageableFeatureName);
        }
        throw error;
      }
    });
  }

  async findById(id: string): Promise<FeatureInstallJob | null> {
    const row = this.db.select().from(featureInstallJobs).where(eq(featureInstallJobs.id, id)).get();
    return row ? toJob(row) : null;
  }

  async findActive(): Promise<FeatureInstallJob | null> {
    const row = this.db.select().from(featureInstallJobs).where(eq(featureInstallJobs.activeSlot, 1)).get();
    return row ? toJob(row) : null;
  }

  async listRecentTerminal(limit: number): Promise<readonly FeatureInstallJob[]> {
    return this.db.select()
      .from(featureInstallJobs)
      .where(inArray(featureInstallJobs.status, ['succeeded', 'failed']))
      .orderBy(desc(featureInstallJobs.updatedAt))
      .limit(limit)
      .all()
      .map(toJob);
  }

  async markRunning(id: string, now: Date): Promise<FeatureInstallJob> {
    const [row] = this.db.update(featureInstallJobs)
      .set({ status: 'running', updatedAt: now })
      .where(and(eq(featureInstallJobs.id, id), eq(featureInstallJobs.status, 'queued')))
      .returning()
      .all();
    if (!row) throw new RangeError(`Install job '${id}' is not queued`);
    return toJob(row);
  }

  async markAwaitingRestart(input: {
    id: string;
    restartScope: RestartScope;
    dispatchIdentity: string;
    now: Date;
  }): Promise<FeatureInstallJob> {
    return this.immediate((tx) => {
      this.requireActiveJob(tx, input.id, ['running']);
      const [row] = tx.update(featureInstallJobs)
        .set({
          status: 'awaiting-restart',
          activeSlot: 1,
          restartScope: input.restartScope,
          restartDispatchIdentity: input.dispatchIdentity,
          failureCode: null,
          updatedAt: input.now,
        })
        .where(and(eq(featureInstallJobs.id, input.id), eq(featureInstallJobs.status, 'running')))
        .returning()
        .all();
      if (!row) throw new RangeError(`Install job '${input.id}' state changed before awaiting a restart`);
      return toJob(row);
    });
  }

  async recordRestartDispatch(input: {
    id: string;
    dispatchIdentity: string;
    now: Date;
  }): Promise<FeatureInstallJob> {
    return this.immediate((tx) => {
      this.requireActiveJob(tx, input.id, ['awaiting-restart']);
      const [row] = tx.update(featureInstallJobs)
        .set({ restartDispatchIdentity: input.dispatchIdentity, updatedAt: input.now })
        .where(and(eq(featureInstallJobs.id, input.id), eq(featureInstallJobs.status, 'awaiting-restart')))
        .returning()
        .all();
      if (!row) throw new RangeError(`Install job '${input.id}' state changed before restart dispatch`);
      return toJob(row);
    });
  }

  async terminalizeSuccess(input: {
    id: string;
    restartScope: RestartScope;
    now: Date;
  }): Promise<FeatureInstallJob> {
    return this.immediate((tx) => {
      const job = this.requireActiveJob(tx, input.id, ['running', 'awaiting-restart']);
      const [row] = tx.update(featureInstallJobs)
        .set({
          status: 'succeeded',
          activeSlot: null,
          restartScope: input.restartScope,
          failureCode: null,
          updatedAt: input.now,
        })
        .where(and(eq(featureInstallJobs.id, input.id), eq(featureInstallJobs.status, job.status)))
        .returning()
        .all();
      if (!row) throw new RangeError(`Install job '${input.id}' state changed before terminal success`);

      const result = tx.update(features)
        .set({ installed: true, enabled: true, attentionReason: null })
        .where(eq(features.name, job.featureName))
        .run();
      if (result.changes !== 1) throw new RangeError(`Feature '${job.featureName}' is missing`);
      return toJob(row);
    });
  }

  async terminalizeFailure(input: {
    id: string;
    failureCode: FeatureInstallFailureCode;
    attentionReason: FeatureAttentionReason | null;
    preservePreviousState: boolean;
    now: Date;
  }): Promise<FeatureInstallJob> {
    return this.immediate((tx) => {
      const job = this.requireActiveJob(tx, input.id, ['queued', 'running', 'awaiting-restart']);
      const [row] = tx.update(featureInstallJobs)
        .set({
          status: 'failed',
          activeSlot: null,
          restartScope: null,
          failureCode: input.failureCode,
          updatedAt: input.now,
        })
        .where(and(eq(featureInstallJobs.id, input.id), eq(featureInstallJobs.status, job.status)))
        .returning()
        .all();
      if (!row) throw new RangeError(`Install job '${input.id}' state changed before terminal failure`);

      const update = input.preservePreviousState
        ? { installed: job.previousInstalled, enabled: job.previousEnabled, attentionReason: input.attentionReason }
        : { attentionReason: input.attentionReason };
      const result = tx.update(features).set(update).where(eq(features.name, job.featureName)).run();
      if (result.changes !== 1) throw new RangeError(`Feature '${job.featureName}' is missing`);
      return toJob(row);
    });
  }

  private immediate<T>(operation: (tx: JobWriter) => T): T {
    return this.db.transaction((tx) => operation(tx), { behavior: 'immediate' });
  }

  private requireActiveJob(
    tx: JobWriter,
    id: string,
    allowed: readonly FeatureInstallJobStatus[],
  ): JobRow {
    const job = tx.select().from(featureInstallJobs).where(eq(featureInstallJobs.id, id)).get();
    if (job?.activeSlot !== 1 || !allowed.includes(job.status as FeatureInstallJobStatus)) {
      throw new RangeError(`Install job '${id}' is not active`);
    }
    return job;
  }
}

function isActiveSlotViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const sqlite = error as { code?: unknown; message?: unknown };
  return sqlite.code === 'SQLITE_CONSTRAINT_UNIQUE'
    && typeof sqlite.message === 'string'
    && sqlite.message.includes('feature_install_jobs.active_slot');
}

function toJob(row: JobRow): FeatureInstallJob {
  return {
    id: row.id,
    feature: row.featureName as ManageableFeatureName,
    status: row.status as FeatureInstallJobStatus,
    activeSlot: row.activeSlot === 1 ? 1 : null,
    operation: row.operation as FeatureInstallOperation,
    requestedByUserId: row.requestedByUserId,
    requestedInChatId: row.requestedInChatId,
    workflowReceiptId: row.workflowReceiptId,
    previousInstalled: row.previousInstalled,
    previousEnabled: row.previousEnabled,
    restartScope: row.restartScope as RestartScope | null,
    restartDispatchIdentity: row.restartDispatchIdentity,
    failureCode: row.failureCode as FeatureInstallFailureCode | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

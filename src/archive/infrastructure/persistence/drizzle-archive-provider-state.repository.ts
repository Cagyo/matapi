import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { AppDatabase, DB } from '../../../database/database.module';
import { archiveProviderState } from '../../../database/schema';
import type {
  ArchiveProviderState,
  ArchiveProviderStateRepositoryPort,
} from '../../application/ports/archive-provider-state-repository.port';

type StateRow = typeof archiveProviderState.$inferSelect;
type Writer = Pick<AppDatabase, 'insert' | 'select' | 'update'>;

/** SQLite singleton provider-gate state with revision-fenced writes. */
@Injectable()
export class DrizzleArchiveProviderStateRepository implements ArchiveProviderStateRepositoryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async load(): Promise<ArchiveProviderState> {
    return this.immediate((tx) => toState(this.ensure(tx)));
  }

  async activateGeneration(expectedRevision: number, generationId: string, nowMs: number): Promise<boolean> {
    return this.immediate((tx) => {
      this.ensure(tx);
      const result = tx.update(archiveProviderState).set({
        revision: expectedRevision + 1,
        generationId,
        operationClass: null,
        failureClass: null,
        failureStreak: 0,
        cooldownUntil: null,
        blockReason: null,
        updatedAt: nowMs,
      }).where(and(eq(archiveProviderState.id, 1), eq(archiveProviderState.revision, expectedRevision))).run();
      return result.changes === 1;
    });
  }

  async compareAndSet(expectedRevision: number, next: Omit<ArchiveProviderState, 'revision'>): Promise<boolean> {
    return this.immediate((tx) => {
      this.ensure(tx);
      const result = tx.update(archiveProviderState).set({
        revision: expectedRevision + 1,
        generationId: next.generationId,
        operationClass: next.operationClass,
        failureClass: next.failureClass,
        failureStreak: next.failureStreak,
        cooldownUntil: next.cooldownUntilMs,
        blockReason: next.blockReason,
        updatedAt: next.updatedAtMs,
      }).where(and(eq(archiveProviderState.id, 1), eq(archiveProviderState.revision, expectedRevision))).run();
      return result.changes === 1;
    });
  }

  async requestProbe(input: {
    generationId: string;
    expectedRevision: number;
    allowedBlockReasons: readonly ('account_creation_limit' | 'policy_blocked')[];
    nowMs: number;
  }): Promise<boolean> {
    if (input.allowedBlockReasons.length === 0) return false;
    return this.immediate((tx) => {
      this.ensure(tx);
      const result = tx.update(archiveProviderState).set({
        revision: input.expectedRevision + 1,
        cooldownUntil: input.nowMs,
        updatedAt: input.nowMs,
      }).where(and(
        eq(archiveProviderState.id, 1),
        eq(archiveProviderState.generationId, input.generationId),
        eq(archiveProviderState.revision, input.expectedRevision),
        inArray(archiveProviderState.blockReason, [...input.allowedBlockReasons]),
        isNull(archiveProviderState.cooldownUntil),
      )).run();
      return result.changes === 1;
    });
  }

  private ensure(tx: Writer): StateRow {
    tx.insert(archiveProviderState).values(emptyRow()).onConflictDoNothing().run();
    const row = tx.select().from(archiveProviderState).where(eq(archiveProviderState.id, 1)).get();
    if (!row) throw new Error('Archive provider state singleton was not created');
    return row;
  }

  private immediate<T>(operation: (tx: Writer) => T): T {
    return this.db.transaction((tx) => operation(tx), { behavior: 'immediate' });
  }
}

function emptyRow() {
  return {
    id: 1,
    revision: 0,
    generationId: null,
    operationClass: null,
    failureClass: null,
    failureStreak: 0,
    cooldownUntil: null,
    blockReason: null,
    updatedAt: 0,
  };
}

function toState(row: StateRow): ArchiveProviderState {
  return Object.freeze({
    revision: row.revision,
    generationId: row.generationId,
    operationClass: row.operationClass as ArchiveProviderState['operationClass'],
    failureClass: row.failureClass as ArchiveProviderState['failureClass'],
    failureStreak: row.failureStreak,
    cooldownUntilMs: row.cooldownUntil,
    blockReason: row.blockReason as ArchiveProviderState['blockReason'],
    updatedAtMs: row.updatedAt,
  });
}

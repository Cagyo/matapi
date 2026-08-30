import { Logger } from '@nestjs/common';
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import type { AppDatabase } from '../../../database/database.module';
import { archiveProviderState, driveConnections, events } from '../../../database/schema';
import type { EventQueueOptions } from '../../../events/application/ports/event-queue-options.port';
import type { NewQueuedEvent, QueuedEvent } from '../../../events/domain/queued-event.entity';
import type { ArchiveAdminAlertKind } from '../../application/ports/archive-admin-alert.port';
import type {
  ArchiveAdminAlertOutboxInput,
  ArchiveAdminAlertOutboxPort,
  ArchiveProviderProbeFailureSettlementInput,
} from '../../application/ports/archive-admin-alert-outbox.port';

type EventRow = typeof events.$inferSelect;
type TransactionWriter = Pick<AppDatabase, 'delete' | 'insert' | 'select' | 'update'>;

/** Owns the cross-table SQLite transaction for archive alert cooldown plus outbox. */
export class DrizzleArchiveAdminAlertOutboxAdapter implements ArchiveAdminAlertOutboxPort {
  private readonly logger = new Logger(DrizzleArchiveAdminAlertOutboxAdapter.name);
  private overflowCount = 0;

  constructor(
    private readonly db: AppDatabase,
    private readonly options: Pick<EventQueueOptions, 'maxUnsentEvents'>,
  ) {}

  async enqueue(input: ArchiveAdminAlertOutboxInput): Promise<QueuedEvent | null> {
    const result = this.db.transaction((tx) => {
      const row = tx.select({ cooldowns: driveConnections.alertCooldowns })
        .from(driveConnections)
        .where(and(
          eq(driveConnections.id, input.fence.id),
          eq(driveConnections.currentSlot, 1),
          eq(driveConnections.revision, input.fence.revision),
          eq(driveConnections.status, input.fence.status),
        ))
        .get();
      if (row === undefined) return null;
      const current = parseCooldowns(row.cooldowns);
      if ((current[input.kind] ?? 0) > input.nowMs) return null;
      const next = { ...current, [input.kind]: input.cooldownUntilMs };
      const updated = tx.update(driveConnections)
        .set({ alertCooldowns: next })
        .where(and(
          eq(driveConnections.id, input.fence.id),
          eq(driveConnections.currentSlot, 1),
          eq(driveConnections.revision, input.fence.revision),
          eq(driveConnections.status, input.fence.status),
          sql`${driveConnections.alertCooldowns} = ${JSON.stringify(current)}`,
        ))
        .run();
      if (updated.changes !== 1) return null;
      return enqueueWithinTransaction(tx, this.options, toEvent(input));
    });
    if (result?.evicted) this.recordOverflow();
    return result?.queued ?? null;
  }

  async settleProviderProbeFailure(
    input: ArchiveProviderProbeFailureSettlementInput,
  ): Promise<'settled' | 'lost'> {
    if (input.nextProviderState.generationId !== input.fence.id
      || input.nextProviderState.operationClass === null) return 'lost';
    const operationClass = input.nextProviderState.operationClass;
    try {
      const result = this.db.transaction((tx) => {
        const provider = tx.select().from(archiveProviderState).where(and(
          eq(archiveProviderState.id, 1),
          eq(archiveProviderState.generationId, input.fence.id),
          eq(archiveProviderState.revision, input.expectedProviderRevision),
          eq(archiveProviderState.operationClass, operationClass),
        )).get();
        if (provider === undefined) return { outcome: 'lost' as const, evicted: false };

        const active = tx.select({
          cooldowns: driveConnections.alertCooldowns,
        }).from(driveConnections).where(and(
          eq(driveConnections.id, input.fence.id),
          eq(driveConnections.currentSlot, 1),
          eq(driveConnections.revision, input.fence.revision),
          eq(driveConnections.status, input.fence.status),
        )).get();
        if (active === undefined) return { outcome: 'lost' as const, evicted: false };

        const providerUpdated = tx.update(archiveProviderState).set({
          revision: input.expectedProviderRevision + 1,
          generationId: input.nextProviderState.generationId,
          operationClass,
          failureClass: input.nextProviderState.failureClass,
          failureStreak: input.nextProviderState.failureStreak,
          cooldownUntil: input.nextProviderState.cooldownUntilMs,
          blockReason: input.nextProviderState.blockReason,
          updatedAt: input.nextProviderState.updatedAtMs,
        }).where(and(
          eq(archiveProviderState.id, 1),
          eq(archiveProviderState.generationId, input.fence.id),
          eq(archiveProviderState.revision, input.expectedProviderRevision),
          eq(archiveProviderState.operationClass, operationClass),
        )).run();
        if (providerUpdated.changes !== 1) throw LOST_SETTLEMENT;

        const currentCooldowns = parseCooldowns(active.cooldowns);
        if ((currentCooldowns[input.alertKind] ?? 0) > input.nowMs) {
          return { outcome: 'settled' as const, evicted: false };
        }
        const nextCooldowns = {
          ...currentCooldowns,
          [input.alertKind]: Math.max(
            currentCooldowns[input.alertKind] ?? 0,
            input.alertCooldownUntilMs,
          ),
        };
        const cooldownUpdated = tx.update(driveConnections).set({
          alertCooldowns: nextCooldowns,
        }).where(and(
          eq(driveConnections.id, input.fence.id),
          eq(driveConnections.currentSlot, 1),
          eq(driveConnections.revision, input.fence.revision),
          eq(driveConnections.status, input.fence.status),
          active.cooldowns === null
            ? isNull(driveConnections.alertCooldowns)
            : sql`${driveConnections.alertCooldowns} = ${JSON.stringify(currentCooldowns)}`,
        )).run();
        if (cooldownUpdated.changes !== 1) throw LOST_SETTLEMENT;

        const queued = enqueueWithinTransaction(tx, this.options, toEvent({
          kind: input.alertKind,
          ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
          nowMs: input.nowMs,
        }));
        return { outcome: 'settled' as const, evicted: queued.evicted };
      }, { behavior: 'immediate' });
      if (result.evicted) this.recordOverflow();
      return result.outcome;
    } catch (error) {
      if (error === LOST_SETTLEMENT) return 'lost';
      throw error;
    }
  }

  private recordOverflow(): void {
    this.overflowCount += 1;
    if (!isPowerOfTwo(this.overflowCount)) return;
    this.logger.warn(
      `Durable unsent queue overflow: count=${this.overflowCount}, bound=${this.options.maxUnsentEvents}`,
    );
  }
}

const LOST_SETTLEMENT = new Error('Archive provider probe settlement lost its fence');

function enqueueWithinTransaction(
  writer: TransactionWriter,
  options: Pick<EventQueueOptions, 'maxUnsentEvents'>,
  event: NewQueuedEvent,
): { queued: QueuedEvent; evicted: boolean } {
  const [{ value }] = writer.select({ value: count() })
    .from(events).where(isNull(events.sentAt)).all();
  let evicted = false;
  if (value >= options.maxUnsentEvents) {
    const oldest = writer.select({ id: events.id }).from(events)
      .where(isNull(events.sentAt))
      .orderBy(asc(events.createdAt), asc(events.id))
      .limit(1).get();
    if (oldest) {
      writer.delete(events).where(eq(events.id, oldest.id)).run();
      evicted = true;
    }
  }
  const [row] = writer.insert(events).values(event).returning().all();
  return { queued: toQueuedEvent(row), evicted };
}

function toEvent(input: {
  kind: ArchiveAdminAlertKind;
  errorCode?: string;
  nowMs: number;
}): NewQueuedEvent {
  return {
    sensorId: null,
    type: 'archive_admin_alert',
    payload: {
      kind: input.kind,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    },
    createdAt: new Date(input.nowMs),
  };
}

function toQueuedEvent(row: EventRow): QueuedEvent {
  return {
    id: row.id,
    sensorId: row.sensorId,
    type: row.type,
    payload: row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? row.payload as Record<string, unknown>
      : null,
    createdAt: row.createdAt,
  };
}

function parseCooldowns(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(
    ([key, entry]) => key.length > 0 && Number.isSafeInteger(entry) && Number(entry) >= 0,
  ));
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && Number.isInteger(Math.log2(value));
}

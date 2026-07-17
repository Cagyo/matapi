import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { homeActionReceipts, notificationPauseReceipts, users } from '../../database/schema';
import type { HomeActionRepositoryPort, WorkflowClaimResult } from '../application/ports/home-action-repository.port';
import {
  isExternalReceipt,
  isHomeActionReceipt,
  type ClaimedExternalAction,
  type HomeActionReceipt,
  type UndoReceiptKind,
} from '../domain/home-action-receipt';
import {
  canTransitionWorkflowDeliveryStage,
  type WorkflowDeliveryStage,
  type WorkflowReturnPhase,
  type WorkflowReturnReceipt,
} from '../domain/workflow-return';

type ReceiptRow = typeof homeActionReceipts.$inferSelect;
type ReceiptWriter = Pick<AppDatabase, 'insert' | 'select' | 'update' | 'delete'>;

function key(input: Pick<HomeActionReceipt, 'userId' | 'chatId' | 'kind'>) {
  return and(
    eq(homeActionReceipts.userId, input.userId),
    eq(homeActionReceipts.chatId, input.chatId),
    eq(homeActionReceipts.kind, input.kind),
  );
}

function decode(row: ReceiptRow): HomeActionReceipt | null {
  let payload: unknown;
  try { payload = JSON.parse(row.payload); } catch { return null; }
  const receipt: unknown = {
    id: row.id, userId: row.userId, chatId: row.chatId, kind: row.kind,
    sessionToken: row.sessionToken, status: row.status, payload, expiresAt: row.expiresAt,
  };
  return isHomeActionReceipt(receipt) ? receipt : null;
}

/** Persistent receipt authority; guarded state changes use SQLite immediate transactions. */
@Injectable()
export class DrizzleHomeActionRepository implements HomeActionRepositoryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async create(receipt: HomeActionReceipt): Promise<void> {
    if (!isHomeActionReceipt(receipt)) throw new RangeError('Invalid Home action receipt');
    this.immediate((tx) => {
      tx.insert(homeActionReceipts).values({
        userId: receipt.userId, chatId: receipt.chatId, kind: receipt.kind, id: receipt.id,
        sessionToken: receipt.sessionToken, status: receipt.status, payload: JSON.stringify(receipt.payload),
        expiresAt: receipt.expiresAt, updatedAt: receipt.expiresAt,
      }).onConflictDoUpdate({
        target: [homeActionReceipts.userId, homeActionReceipts.chatId, homeActionReceipts.kind],
        set: {
          id: receipt.id, sessionToken: receipt.sessionToken, status: receipt.status,
          payload: JSON.stringify(receipt.payload), expiresAt: receipt.expiresAt, updatedAt: receipt.expiresAt,
        },
      }).run();
    });
  }

  async createPauseConfirmation(receipt: Extract<HomeActionReceipt, { kind: 'pause-confirmation' }>): Promise<void> {
    return this.create(receipt);
  }

  async createExternalConfirmation(receipt: Extract<HomeActionReceipt, { kind: 'cleanup-confirmation' | 'restart-confirmation' }>): Promise<void> {
    return this.create(receipt);
  }

  async confirmPause(input: { userId: number; chatId: number; token: string; id: string; hours: 1 | 4 | 8; now: Date }): Promise<{ kind: 'applied'; expectedRevision: number } | { kind: 'expired' | 'superseded' | 'terminal' }> {
    return this.immediate((tx) => {
      const row = tx.select().from(homeActionReceipts).where(key({ ...input, kind: 'pause-confirmation' })).get();
      const receipt = row && decode(row);
      if (receipt?.kind !== 'pause-confirmation' || receipt.id !== input.id || receipt.sessionToken !== input.token || receipt.payload.hours !== input.hours) return { kind: 'superseded' };
      if (receipt.status === 'completed') return { kind: 'terminal' };
      if (receipt.expiresAt.getTime() <= input.now.getTime()) return { kind: 'expired' };
      const user = tx.select().from(users).where(eq(users.telegramId, input.userId)).get();
      if (!user || user.muted) return { kind: 'superseded' };
      const expectedRevision = user.notificationPauseRevision ?? 0;
      const pausedUntil = new Date(input.now.getTime() + input.hours * 3_600_000);
      const updated = tx.update(users).set({ nonCriticalPausedUntil: pausedUntil, notificationPauseRevision: expectedRevision + 1 })
        .where(and(eq(users.telegramId, input.userId), eq(users.notificationPauseRevision, expectedRevision))).run();
      if (updated.changes !== 1) return { kind: 'superseded' };
      const foundation = tx.insert(notificationPauseReceipts).values({
        userId: input.userId,
        previousPausedUntil: user.nonCriticalPausedUntil && user.nonCriticalPausedUntil.getTime() > input.now.getTime() ? user.nonCriticalPausedUntil : null,
        appliedPausedUntil: pausedUntil, expectedRevision: expectedRevision + 1,
        expiresAt: pausedUntil, consumedAt: null, createdAt: input.now,
      }).returning().get();
      this.upsert(tx, {
        id: input.id, userId: input.userId, chatId: input.chatId, kind: 'undo-non-critical-pause', sessionToken: null,
        status: 'pending', expiresAt: pausedUntil,
        payload: { foundationReceiptId: foundation.id, expectedRevision: expectedRevision + 1 },
      });
      const completed = tx.update(homeActionReceipts).set({ status: 'completed', updatedAt: input.now })
        .where(and(key({ ...input, kind: 'pause-confirmation' }), eq(homeActionReceipts.id, input.id), eq(homeActionReceipts.sessionToken, input.token), eq(homeActionReceipts.status, 'pending'))).run();
      if (completed.changes !== 1) throw new Error('Pause confirmation changed during transaction');
      return { kind: 'applied', expectedRevision: expectedRevision + 1 };
    });
  }

  async undoPause(input: { userId: number; chatId: number; id: string; now: Date }): Promise<{ kind: 'applied' } | { kind: 'expired' | 'superseded' | 'terminal' }> {
    return this.immediate((tx) => {
      const row = tx.select().from(homeActionReceipts).where(key({ ...input, kind: 'undo-non-critical-pause' })).get();
      const receipt = row && decode(row);
      if (receipt?.kind !== 'undo-non-critical-pause' || receipt.id !== input.id) return { kind: 'superseded' };
      if (receipt.status === 'completed') return { kind: 'terminal' };
      if (receipt.expiresAt.getTime() <= input.now.getTime()) return { kind: 'expired' };
      const foundation = tx.select().from(notificationPauseReceipts).where(and(eq(notificationPauseReceipts.id, receipt.payload.foundationReceiptId), eq(notificationPauseReceipts.userId, input.userId))).get();
      if (!foundation || foundation.consumedAt) return { kind: 'superseded' };
      const restored = foundation.previousPausedUntil && foundation.previousPausedUntil.getTime() > input.now.getTime() ? foundation.previousPausedUntil : null;
      const updated = tx.update(users).set({ nonCriticalPausedUntil: restored, notificationPauseRevision: receipt.payload.expectedRevision + 1 })
        .where(and(eq(users.telegramId, input.userId), eq(users.notificationPauseRevision, receipt.payload.expectedRevision))).run();
      if (updated.changes !== 1) return { kind: 'superseded' };
      tx.update(notificationPauseReceipts).set({ consumedAt: input.now }).where(eq(notificationPauseReceipts.id, foundation.id)).run();
      tx.update(homeActionReceipts).set({ status: 'completed', updatedAt: input.now }).where(and(key({ ...input, kind: 'undo-non-critical-pause' }), eq(homeActionReceipts.id, input.id), eq(homeActionReceipts.status, 'pending'))).run();
      return { kind: 'applied' };
    });
  }

  async setQuietHours(input: { userId: number; chatId: number; start: string | null; end: string | null; id: string; expiresAt: Date; now: Date }): Promise<{ kind: 'applied'; changed: boolean } | { kind: 'superseded' }> {
    if ((input.start === null) !== (input.end === null)) throw new RangeError('Quiet hours require both range ends or neither');
    return this.immediate((tx) => {
      const user = tx.select().from(users).where(eq(users.telegramId, input.userId)).get();
      if (!user) return { kind: 'superseded' };
      const changed = (user.quietStart ?? null) !== input.start || (user.quietEnd ?? null) !== input.end;
      if (!changed) return { kind: 'applied', changed: false };
      const expectedRevision = user.notificationPauseRevision ?? 0;
      const updated = tx.update(users).set({ quietStart: input.start, quietEnd: input.end, notificationPauseRevision: expectedRevision + 1 })
        .where(and(eq(users.telegramId, input.userId), eq(users.notificationPauseRevision, expectedRevision))).run();
      if (updated.changes !== 1) return { kind: 'superseded' };
      this.upsert(tx, {
        id: input.id, userId: input.userId, chatId: input.chatId, kind: 'undo-quiet-hours', sessionToken: null, status: 'pending', expiresAt: input.expiresAt,
        payload: { start: user.quietStart ?? null, end: user.quietEnd ?? null, expectedRevision: expectedRevision + 1 },
      });
      return { kind: 'applied', changed: true };
    });
  }

  async undoQuietHours(input: { userId: number; chatId: number; id: string; now: Date }): Promise<{ kind: 'applied' } | { kind: 'expired' | 'superseded' | 'terminal' }> {
    return this.immediate((tx) => {
      const row = tx.select().from(homeActionReceipts).where(key({ ...input, kind: 'undo-quiet-hours' })).get();
      const receipt = row && decode(row);
      if (receipt?.kind !== 'undo-quiet-hours' || receipt.id !== input.id) return { kind: 'superseded' };
      if (receipt.status === 'completed') return { kind: 'terminal' };
      if (receipt.expiresAt.getTime() <= input.now.getTime()) return { kind: 'expired' };
      const updated = tx.update(users).set({ quietStart: receipt.payload.start, quietEnd: receipt.payload.end, notificationPauseRevision: receipt.payload.expectedRevision + 1 })
        .where(and(eq(users.telegramId, input.userId), eq(users.notificationPauseRevision, receipt.payload.expectedRevision))).run();
      if (updated.changes !== 1) return { kind: 'superseded' };
      tx.update(homeActionReceipts).set({ status: 'completed', updatedAt: input.now }).where(and(key({ ...input, kind: 'undo-quiet-hours' }), eq(homeActionReceipts.id, input.id), eq(homeActionReceipts.status, 'pending'))).run();
      return { kind: 'applied' };
    });
  }

  async findCurrentUndo(input: { userId: number; chatId: number; kind: UndoReceiptKind; now: Date }): Promise<HomeActionReceipt | null> {
    const row = this.db.select().from(homeActionReceipts).where(key(input)).get();
    const receipt = row && decode(row);
    return receipt?.status === 'pending' && receipt.expiresAt.getTime() > input.now.getTime() ? receipt : null;
  }

  async claimExternal(input: { userId: number; chatId: number; token: string; kind: ClaimedExternalAction['kind']; id: string; now: Date }): Promise<{ kind: 'claimed'; action: ClaimedExternalAction } | { kind: 'expired' | 'superseded' | 'executing' | 'terminal' }> {
    return this.immediate((tx) => {
      const row = tx.select().from(homeActionReceipts).where(key(input)).get();
      const receipt = row && decode(row);
      if (!receipt || !isExternalReceipt(receipt) || receipt.id !== input.id || receipt.sessionToken !== input.token) return { kind: 'superseded' };
      if (receipt.status === 'executing') return { kind: 'executing' };
      if (receipt.status === 'completed' || receipt.status === 'failed') return { kind: 'terminal' };
      if (receipt.expiresAt.getTime() <= input.now.getTime()) return { kind: 'expired' };
      const result = tx.update(homeActionReceipts)
        .set({ status: 'executing', updatedAt: input.now })
        .where(and(key(input), eq(homeActionReceipts.id, input.id), eq(homeActionReceipts.sessionToken, input.token), eq(homeActionReceipts.status, 'pending')))
        .run();
      if (result.changes !== 1) return { kind: 'superseded' };
      return { kind: 'claimed', action: { id: receipt.id, userId: receipt.userId, chatId: receipt.chatId, kind: receipt.kind } };
    });
  }

  async finishExternal(input: { action: ClaimedExternalAction; outcome: 'completed' | 'failed'; now: Date }): Promise<void> {
    this.immediate((tx) => {
      tx.update(homeActionReceipts)
        .set({ status: input.outcome, updatedAt: input.now })
        .where(and(key(input.action), eq(homeActionReceipts.id, input.action.id), eq(homeActionReceipts.status, 'executing')))
        .run();
    });
  }

  async beginWorkflowReturn(receipt: WorkflowReturnReceipt): Promise<WorkflowReturnReceipt | null> {
    if (!isHomeActionReceipt(receipt) || receipt.kind !== 'workflow-return') {
      throw new RangeError('Invalid workflow return receipt');
    }
    return this.immediate((tx) => {
      const row = tx.select().from(homeActionReceipts).where(key(receipt)).get();
      const current = row && decode(row);
      this.upsert(tx, receipt);
      return current?.kind === 'workflow-return' ? current : null;
    });
  }

  async findWorkflowReturn(input: { userId: number; chatId: number; now: Date }): Promise<WorkflowReturnReceipt | null> {
    const row = this.db.select().from(homeActionReceipts)
      .where(key({ ...input, kind: 'workflow-return' }))
      .get();
    const receipt = row && decode(row);
    return receipt?.kind === 'workflow-return' && receipt.expiresAt.getTime() > input.now.getTime()
      ? receipt
      : null;
  }

  async updateWorkflowReturnPhase(input: { userId: number; chatId: number; id: string; phase: WorkflowReturnPhase; expiresAt: Date; now: Date }): Promise<'updated' | 'expired' | 'superseded' | 'terminal'> {
    return this.immediate((tx) => {
      const receiptKey = key({ ...input, kind: 'workflow-return' });
      const row = tx.select().from(homeActionReceipts).where(receiptKey).get();
      const receipt = row && decode(row);
      if (receipt?.kind !== 'workflow-return' || receipt.id !== input.id) return 'superseded';
      if (receipt.status !== 'pending') return 'terminal';
      if (receipt.expiresAt.getTime() <= input.now.getTime()) return 'expired';
      const updated: WorkflowReturnReceipt = {
        ...receipt,
        expiresAt: new Date(input.expiresAt),
        payload: { ...receipt.payload, phase: input.phase },
      };
      if (!isHomeActionReceipt(updated)) throw new RangeError('Invalid workflow return phase update');
      const result = tx.update(homeActionReceipts)
        .set({ payload: JSON.stringify(updated.payload), expiresAt: updated.expiresAt, updatedAt: input.now })
        .where(and(receiptKey, eq(homeActionReceipts.id, input.id), eq(homeActionReceipts.status, 'pending')))
        .run();
      return result.changes === 1 ? 'updated' : 'superseded';
    });
  }

  async updateWorkflowReturnDeliveryStage(input: { userId: number; chatId: number; id: string; stage: Exclude<WorkflowDeliveryStage, 'pending'>; now: Date }): Promise<'updated' | 'expired' | 'superseded' | 'terminal'> {
    return this.immediate((tx) => {
      const receiptKey = key({ ...input, kind: 'workflow-return' });
      const row = tx.select().from(homeActionReceipts).where(receiptKey).get();
      const receipt = row && decode(row);
      if (receipt?.kind !== 'workflow-return' || receipt.id !== input.id) return 'superseded';
      if (receipt.status !== 'executing' && receipt.status !== 'returned') return 'terminal';
      if (receipt.expiresAt.getTime() <= input.now.getTime()) return 'expired';
      const currentStage = receipt.payload.deliveryStage ?? 'pending';
      if (!canTransitionWorkflowDeliveryStage(currentStage, input.stage)) return 'terminal';
      const updated: WorkflowReturnReceipt = {
        ...receipt,
        payload: { ...receipt.payload, deliveryStage: input.stage },
      };
      if (!isHomeActionReceipt(updated)) throw new RangeError('Invalid workflow return delivery stage update');
      const result = tx.update(homeActionReceipts)
        .set({ payload: JSON.stringify(updated.payload), updatedAt: input.now })
        .where(and(receiptKey, eq(homeActionReceipts.id, input.id), eq(homeActionReceipts.status, receipt.status)))
        .run();
      return result.changes === 1 ? 'updated' : 'superseded';
    });
  }

  async claimWorkflowReturn(input: { userId: number; chatId: number; id: string; now: Date }): Promise<WorkflowClaimResult> {
    return this.immediate((tx) => {
      const receiptKey = key({ ...input, kind: 'workflow-return' });
      const row = tx.select().from(homeActionReceipts).where(receiptKey).get();
      const receipt = row && decode(row);
      if (receipt?.kind !== 'workflow-return' || receipt.id !== input.id) return { kind: 'superseded' };
      if (receipt.status === 'executing') return { kind: 'resumable', receipt };
      if (receipt.status === 'returned') return { kind: 'returned', receipt };
      if (receipt.status === 'completed') return { kind: 'terminal' };
      if (receipt.expiresAt.getTime() <= input.now.getTime()) return { kind: 'expired' };
      const result = tx.update(homeActionReceipts)
        .set({ status: 'executing', updatedAt: input.now })
        .where(and(receiptKey, eq(homeActionReceipts.id, input.id), eq(homeActionReceipts.status, 'pending')))
        .run();
      if (result.changes !== 1) return { kind: 'superseded' };
      return { kind: 'claimed', receipt: { ...receipt, status: 'executing' } };
    });
  }

  async finishWorkflowReturn(input: { userId: number; chatId: number; id: string; outcome: 'returned' | 'completed'; now: Date }): Promise<'finished' | 'superseded' | 'terminal'> {
    return this.immediate((tx) => {
      const receiptKey = key({ ...input, kind: 'workflow-return' });
      const row = tx.select().from(homeActionReceipts).where(receiptKey).get();
      const receipt = row && decode(row);
      if (receipt?.kind !== 'workflow-return' || receipt.id !== input.id) return 'superseded';
      if (receipt.status === 'completed') return 'terminal';
      if (receipt.status !== 'executing' && !(receipt.status === 'returned' && input.outcome === 'completed')) {
        return receipt.status === 'returned' ? 'terminal' : 'superseded';
      }
      const result = tx.update(homeActionReceipts)
        .set({ status: input.outcome, updatedAt: input.now })
        .where(and(receiptKey, eq(homeActionReceipts.id, input.id), eq(homeActionReceipts.status, receipt.status)))
        .run();
      return result.changes === 1 ? 'finished' : 'superseded';
    });
  }

  private immediate<T>(operation: (tx: ReceiptWriter) => T): T {
    return this.db.transaction((tx) => operation(tx), { behavior: 'immediate' });
  }

  private upsert(tx: ReceiptWriter, receipt: HomeActionReceipt): void {
    tx.insert(homeActionReceipts).values({
      userId: receipt.userId, chatId: receipt.chatId, kind: receipt.kind, id: receipt.id, sessionToken: receipt.sessionToken,
      status: receipt.status, payload: JSON.stringify(receipt.payload), expiresAt: receipt.expiresAt, updatedAt: receipt.expiresAt,
    }).onConflictDoUpdate({
      target: [homeActionReceipts.userId, homeActionReceipts.chatId, homeActionReceipts.kind],
      set: { id: receipt.id, sessionToken: receipt.sessionToken, status: receipt.status, payload: JSON.stringify(receipt.payload), expiresAt: receipt.expiresAt, updatedAt: receipt.expiresAt },
    }).run();
  }
}

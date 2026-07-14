import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { homeActionReceipts } from '../../database/schema';
import type { HomeActionRepositoryPort } from '../application/ports/home-action-repository.port';
import {
  isExternalReceipt,
  isHomeActionReceipt,
  type ClaimedExternalAction,
  type HomeActionReceipt,
  type UndoReceiptKind,
} from '../domain/home-action-receipt';

type ReceiptRow = typeof homeActionReceipts.$inferSelect;
type ReceiptWriter = Pick<AppDatabase, 'insert' | 'select' | 'update'>;

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

  async findCurrentUndo(input: { userId: number; chatId: number; kind: UndoReceiptKind; now: Date }): Promise<HomeActionReceipt | null> {
    const row = this.db.select().from(homeActionReceipts).where(key(input)).get();
    const receipt = row && decode(row);
    return receipt && receipt.status === 'pending' && receipt.expiresAt.getTime() > input.now.getTime() ? receipt : null;
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

  private immediate<T>(operation: (tx: ReceiptWriter) => T): T {
    return this.db.transaction((tx) => operation(tx), { behavior: 'immediate' });
  }
}

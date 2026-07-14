import type { HomeActionRepositoryPort } from '../application/ports/home-action-repository.port';
import { isExternalReceipt, isHomeActionReceipt, type HomeActionReceipt } from '../domain/home-action-receipt';

function keyOf(receipt: Pick<HomeActionReceipt, 'userId' | 'chatId' | 'kind'>): string {
  return `${receipt.userId}:${receipt.chatId}:${receipt.kind}`;
}

function clone(receipt: HomeActionReceipt): HomeActionReceipt {
  return { ...receipt, expiresAt: new Date(receipt.expiresAt), payload: { ...receipt.payload } } as HomeActionReceipt;
}

/** Bounded test/mock implementation; replacement semantics mirror the SQLite adapter. */
export class InMemoryHomeActionRepository implements HomeActionRepositoryPort {
  private readonly receipts = new Map<string, HomeActionReceipt>();

  async create(receipt: HomeActionReceipt): Promise<void> {
    if (!isHomeActionReceipt(receipt)) throw new RangeError('Invalid Home action receipt');
    this.receipts.set(keyOf(receipt), clone(receipt));
  }

  async findCurrentUndo(input: { userId: number; chatId: number; kind: 'undo-non-critical-pause' | 'undo-quiet-hours'; now: Date }): Promise<HomeActionReceipt | null> {
    const receipt = this.receipts.get(`${input.userId}:${input.chatId}:${input.kind}`);
    return receipt && receipt.status === 'pending' && receipt.expiresAt.getTime() > input.now.getTime() ? clone(receipt) : null;
  }

  async claimExternal(input: { userId: number; chatId: number; token: string; kind: 'cleanup-confirmation' | 'restart-confirmation'; id: string; now: Date }): Promise<{ kind: 'claimed'; action: { id: string; userId: number; chatId: number; kind: 'cleanup-confirmation' | 'restart-confirmation' } } | { kind: 'expired' | 'superseded' | 'executing' | 'terminal' }> {
    const receipt = this.receipts.get(`${input.userId}:${input.chatId}:${input.kind}`);
    if (!receipt || !isExternalReceipt(receipt) || receipt.id !== input.id || receipt.sessionToken !== input.token) return { kind: 'superseded' };
    if (receipt.status === 'executing') return { kind: 'executing' };
    if (receipt.status === 'completed' || receipt.status === 'failed') return { kind: 'terminal' };
    if (receipt.expiresAt.getTime() <= input.now.getTime()) return { kind: 'expired' };
    const executing = { ...receipt, status: 'executing' as const };
    this.receipts.set(keyOf(executing), executing);
    return { kind: 'claimed', action: { id: receipt.id, userId: receipt.userId, chatId: receipt.chatId, kind: receipt.kind } };
  }

  async finishExternal(input: { action: { id: string; userId: number; chatId: number; kind: 'cleanup-confirmation' | 'restart-confirmation' }; outcome: 'completed' | 'failed'; now: Date }): Promise<void> {
    const receipt = this.receipts.get(`${input.action.userId}:${input.action.chatId}:${input.action.kind}`);
    if (!receipt || !isExternalReceipt(receipt) || receipt.id !== input.action.id || receipt.status !== 'executing') return;
    this.receipts.set(keyOf(receipt), { ...receipt, status: input.outcome });
  }
}

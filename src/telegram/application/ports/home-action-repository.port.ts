import type { ClaimedExternalAction, HomeActionReceipt, UndoReceiptKind } from '../../domain/home-action-receipt';

export const HOME_ACTION_REPOSITORY = Symbol('HOME_ACTION_REPOSITORY');

export interface HomeActionRepositoryPort {
  create(receipt: HomeActionReceipt): Promise<void>;
  findCurrentUndo(input: { userId: number; chatId: number; kind: UndoReceiptKind; now: Date }): Promise<HomeActionReceipt | null>;
  claimExternal(input: { userId: number; chatId: number; token: string; kind: ClaimedExternalAction['kind']; id: string; now: Date }): Promise<{ kind: 'claimed'; action: ClaimedExternalAction } | { kind: 'expired' | 'superseded' | 'executing' | 'terminal' }>;
  finishExternal(input: { action: ClaimedExternalAction; outcome: 'completed' | 'failed'; now: Date }): Promise<void>;
}

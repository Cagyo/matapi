import type { ClaimedExternalAction, HomeActionReceipt, UndoReceiptKind } from '../../domain/home-action-receipt';
import type { WorkflowDeliveryStage, WorkflowReturnPhase, WorkflowReturnReceipt } from '../../domain/workflow-return';

export const HOME_ACTION_REPOSITORY = Symbol('HOME_ACTION_REPOSITORY');

export type WorkflowClaimResult =
  | { kind: 'claimed' | 'resumable'; receipt: WorkflowReturnReceipt }
  | { kind: 'returned'; receipt: WorkflowReturnReceipt }
  | { kind: 'expired' | 'superseded' | 'terminal' };

export interface HomeActionRepositoryPort {
  create(receipt: HomeActionReceipt): Promise<void>;
  createPauseConfirmation(receipt: Extract<HomeActionReceipt, { kind: 'pause-confirmation' }>): Promise<void>;
  createExternalConfirmation(receipt: Extract<HomeActionReceipt, { kind: 'cleanup-confirmation' | 'restart-confirmation' }>): Promise<void>;
  confirmPause(input: { userId: number; chatId: number; token: string; id: string; hours: 1 | 4 | 8; now: Date }): Promise<{ kind: 'applied'; expectedRevision: number } | { kind: 'expired' | 'superseded' | 'terminal' }>;
  undoPause(input: { userId: number; chatId: number; id: string; now: Date }): Promise<{ kind: 'applied' } | { kind: 'expired' | 'superseded' | 'terminal' }>;
  setQuietHours(input: { userId: number; chatId: number; start: string | null; end: string | null; id: string; expiresAt: Date; now: Date }): Promise<{ kind: 'applied'; changed: boolean } | { kind: 'superseded' }>;
  undoQuietHours(input: { userId: number; chatId: number; id: string; now: Date }): Promise<{ kind: 'applied' } | { kind: 'expired' | 'superseded' | 'terminal' }>;
  findCurrentUndo(input: { userId: number; chatId: number; kind: UndoReceiptKind; now: Date }): Promise<HomeActionReceipt | null>;
  claimExternal(input: { userId: number; chatId: number; token: string; kind: ClaimedExternalAction['kind']; id: string; now: Date }): Promise<{ kind: 'claimed'; action: ClaimedExternalAction } | { kind: 'expired' | 'superseded' | 'executing' | 'terminal' }>;
  finishExternal(input: { action: ClaimedExternalAction; outcome: 'completed' | 'failed'; now: Date }): Promise<void>;
  beginWorkflowReturn(receipt: WorkflowReturnReceipt): Promise<WorkflowReturnReceipt | null>;
  findWorkflowReturn(input: { userId: number; chatId: number; now: Date }): Promise<WorkflowReturnReceipt | null>;
  updateWorkflowReturnPhase(input: { userId: number; chatId: number; id: string; phase: WorkflowReturnPhase; expiresAt: Date; now: Date }): Promise<'updated' | 'expired' | 'superseded' | 'terminal'>;
  updateWorkflowReturnDeliveryStage(input: { userId: number; chatId: number; id: string; stage: Exclude<WorkflowDeliveryStage, 'pending'>; now: Date }): Promise<'updated' | 'expired' | 'superseded' | 'terminal'>;
  claimWorkflowReturn(input: { userId: number; chatId: number; id: string; now: Date }): Promise<WorkflowClaimResult>;
  finishWorkflowReturn(input: { userId: number; chatId: number; id: string; outcome: 'returned' | 'completed'; now: Date }): Promise<'finished' | 'superseded' | 'terminal'>;
}

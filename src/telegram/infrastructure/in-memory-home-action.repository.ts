import type { FeatureMutationClaimResult, HomeActionRepositoryPort, WorkflowClaimResult } from '../application/ports/home-action-repository.port';
import { isExternalReceipt, isHomeActionReceipt, type HomeActionReceipt } from '../domain/home-action-receipt';
import {
  canTransitionWorkflowDeliveryStage,
  type WorkflowDeliveryStage,
  type WorkflowReturnPhase,
  type WorkflowReturnReceipt,
} from '../domain/workflow-return';
import { InMemoryUserRepository } from './in-memory-user.repository';
import { runNotificationPreferencesTransaction } from './notification-preferences.transaction';

function keyOf(receipt: Pick<HomeActionReceipt, 'userId' | 'chatId' | 'kind'>): string {
  return `${receipt.userId}:${receipt.chatId}:${receipt.kind}`;
}

function identityOf(receipt: Pick<HomeActionReceipt, 'userId' | 'chatId' | 'kind' | 'id'>): string {
  return `${keyOf(receipt)}:${receipt.id}`;
}

function clone(receipt: HomeActionReceipt): HomeActionReceipt {
  const payload = JSON.parse(JSON.stringify(receipt.payload)) as HomeActionReceipt['payload'];
  return { ...receipt, expiresAt: new Date(receipt.expiresAt), payload } as HomeActionReceipt;
}

function decode(receipt: unknown): HomeActionReceipt | null {
  return isHomeActionReceipt(receipt) ? clone(receipt) : null;
}

/** Bounded test/mock implementation; replacement semantics mirror the SQLite adapter. */
export class InMemoryHomeActionRepository implements HomeActionRepositoryPort {
  private readonly receipts = new Map<string, HomeActionReceipt>();
  private readonly current = new Map<string, string>();

  constructor(private readonly users?: InMemoryUserRepository) {}

  async create(receipt: HomeActionReceipt): Promise<void> {
    if (!isHomeActionReceipt(receipt)) throw new RangeError('Invalid Home action receipt');
    this.setCurrent(receipt);
  }

  async createPauseConfirmation(receipt: Extract<HomeActionReceipt, { kind: 'pause-confirmation' }>): Promise<void> {
    return this.create(receipt);
  }

  async createExternalConfirmation(receipt: Extract<HomeActionReceipt, { kind: 'cleanup-confirmation' | 'restart-confirmation' }>): Promise<void> {
    return this.create(receipt);
  }

  async confirmPause(input: { userId: number; chatId: number; token: string; id: string; hours: 1 | 4 | 8; now: Date }): Promise<{ kind: 'applied'; expectedRevision: number } | { kind: 'expired' | 'superseded' | 'terminal' }> {
    const receipt = this.getCurrent(`${input.userId}:${input.chatId}:pause-confirmation`);
    if (receipt?.kind !== 'pause-confirmation' || receipt.id !== input.id || receipt.sessionToken !== input.token || receipt.payload.hours !== input.hours) return { kind: 'superseded' };
    if (receipt.status === 'completed') return { kind: 'terminal' };
    if (receipt.expiresAt.getTime() <= input.now.getTime()) return { kind: 'expired' };
    if (!this.users) throw new Error('InMemoryHomeActionRepository requires users for notification transitions');
    return this.transaction(async () => runNotificationPreferencesTransaction(this.users!, async () => {
      const state = await this.users!.getNotificationPauseState(input.userId);
      if (!state || state.legacyMuted) return { kind: 'superseded' };
      const pausedUntil = new Date(input.now.getTime() + input.hours * 3_600_000);
      const result = await this.users!.applyNonCriticalPause({
        userId: input.userId, expectedRevision: state.revision,
        pausedUntil, now: input.now,
      });
      if (result.kind !== 'applied') return { kind: 'superseded' };
      this.setCurrent({
        id: input.id, userId: input.userId, chatId: input.chatId, kind: 'undo-non-critical-pause', sessionToken: null,
        status: 'pending', expiresAt: pausedUntil,
        payload: { foundationReceiptId: result.receiptId, expectedRevision: result.state.revision },
      });
      this.save({ ...receipt, status: 'completed' });
      return { kind: 'applied', expectedRevision: result.state.revision };
    }));
  }

  async undoPause(input: { userId: number; chatId: number; id: string; now: Date }): Promise<{ kind: 'applied' } | { kind: 'expired' | 'superseded' | 'terminal' }> {
    const receipt = this.getCurrent(`${input.userId}:${input.chatId}:undo-non-critical-pause`);
    if (receipt?.kind !== 'undo-non-critical-pause' || receipt.id !== input.id) return { kind: 'superseded' };
    if (receipt.status === 'completed') return { kind: 'terminal' };
    if (receipt.expiresAt.getTime() <= input.now.getTime()) return { kind: 'expired' };
    if (!this.users) throw new Error('InMemoryHomeActionRepository requires users for notification transitions');
    return this.transaction(async () => runNotificationPreferencesTransaction(this.users!, async () => {
      const result = await this.users!.undoNonCriticalPause(input.userId, receipt.payload.foundationReceiptId, input.now);
      if (result.kind !== 'applied') return { kind: result.kind === 'expired' ? 'expired' : 'superseded' };
      this.save({ ...receipt, status: 'completed' });
      return { kind: 'applied' };
    }));
  }

  async setQuietHours(input: { userId: number; chatId: number; start: string | null; end: string | null; id: string; expiresAt: Date; now: Date }): Promise<{ kind: 'applied'; changed: boolean } | { kind: 'superseded' }> {
    if ((input.start === null) !== (input.end === null)) throw new RangeError('Quiet hours require both range ends or neither');
    if (!this.users) throw new Error('InMemoryHomeActionRepository requires users for notification transitions');
    return this.transaction(async () => runNotificationPreferencesTransaction(this.users!, async () => {
      const state = await this.users!.getNotificationPauseState(input.userId);
      if (!state) return { kind: 'superseded' };
      const user = await this.users!.findByTelegramId(input.userId);
      if (!user) return { kind: 'superseded' };
      const result = await this.users!.compareAndSetQuietHours({ ...input, expectedRevision: state.revision });
      if (result.kind !== 'applied') return { kind: 'superseded' };
      if (result.changed) this.setCurrent({
        id: input.id, userId: input.userId, chatId: input.chatId, kind: 'undo-quiet-hours', sessionToken: null,
        status: 'pending', expiresAt: input.expiresAt,
        payload: { start: user.quietStart, end: user.quietEnd, expectedRevision: result.state.revision },
      });
      return { kind: 'applied', changed: result.changed };
    }));
  }

  async undoQuietHours(input: { userId: number; chatId: number; id: string; now: Date }): Promise<{ kind: 'applied' } | { kind: 'expired' | 'superseded' | 'terminal' }> {
    const receipt = this.getCurrent(`${input.userId}:${input.chatId}:undo-quiet-hours`);
    if (receipt?.kind !== 'undo-quiet-hours' || receipt.id !== input.id) return { kind: 'superseded' };
    if (receipt.status === 'completed') return { kind: 'terminal' };
    if (receipt.expiresAt.getTime() <= input.now.getTime()) return { kind: 'expired' };
    if (!this.users) throw new Error('InMemoryHomeActionRepository requires users for notification transitions');
    return this.transaction(async () => runNotificationPreferencesTransaction(this.users!, async () => {
      const result = await this.users!.compareAndSetQuietHours({ userId: input.userId, expectedRevision: receipt.payload.expectedRevision, start: receipt.payload.start, end: receipt.payload.end, now: input.now });
      if (result.kind !== 'applied') return { kind: 'superseded' };
      this.save({ ...receipt, status: 'completed' });
      return { kind: 'applied' };
    }));
  }

  async findCurrentUndo(input: { userId: number; chatId: number; kind: 'undo-non-critical-pause' | 'undo-quiet-hours'; now: Date }): Promise<HomeActionReceipt | null> {
    const receipt = this.getCurrent(`${input.userId}:${input.chatId}:${input.kind}`);
    return receipt?.status === 'pending' && receipt.expiresAt.getTime() > input.now.getTime() ? clone(receipt) : null;
  }

  async claimExternal(input: { userId: number; chatId: number; token: string; kind: 'cleanup-confirmation' | 'restart-confirmation'; id: string; now: Date }): Promise<{ kind: 'claimed'; action: { id: string; userId: number; chatId: number; kind: 'cleanup-confirmation' | 'restart-confirmation' } } | { kind: 'expired' | 'superseded' | 'executing' | 'terminal' }> {
    const receipt = this.getCurrent(`${input.userId}:${input.chatId}:${input.kind}`);
    if (!receipt || !isExternalReceipt(receipt) || receipt.id !== input.id || receipt.sessionToken !== input.token) return { kind: 'superseded' };
    if (receipt.status === 'executing') return { kind: 'executing' };
    if (receipt.status === 'completed' || receipt.status === 'failed') return { kind: 'terminal' };
    if (receipt.expiresAt.getTime() <= input.now.getTime()) return { kind: 'expired' };
    const executing = { ...receipt, status: 'executing' as const };
    this.save(executing);
    return { kind: 'claimed', action: { id: receipt.id, userId: receipt.userId, chatId: receipt.chatId, kind: receipt.kind } };
  }

  async finishExternal(input: { action: { id: string; userId: number; chatId: number; kind: 'cleanup-confirmation' | 'restart-confirmation' }; outcome: 'completed' | 'failed'; now: Date }): Promise<void> {
    const receipt = this.getExact(input.action);
    if (!receipt || !isExternalReceipt(receipt) || receipt.userId !== input.action.userId
      || receipt.chatId !== input.action.chatId || receipt.kind !== input.action.kind || receipt.status !== 'executing') return;
    this.save({ ...receipt, status: input.outcome });
  }

  async beginWorkflowReturn(receipt: WorkflowReturnReceipt): Promise<WorkflowReturnReceipt | null> {
    if (!isHomeActionReceipt(receipt) || receipt.kind !== 'workflow-return') {
      throw new RangeError('Invalid workflow return receipt');
    }
    return this.transactionSync(() => {
      const current = this.getCurrent(keyOf(receipt));
      this.setCurrent(receipt);
      return current?.kind === 'workflow-return' ? current : null;
    });
  }

  async findWorkflowReturn(input: { userId: number; chatId: number; now: Date }): Promise<WorkflowReturnReceipt | null> {
    const receipt = this.getCurrent(`${input.userId}:${input.chatId}:workflow-return`);
    return receipt?.kind === 'workflow-return' && (receipt.status === 'executing' || receipt.expiresAt.getTime() > input.now.getTime())
      ? receipt
      : null;
  }

  async findWorkflowReturnExact(input: { userId: number; chatId: number; id: string; now: Date }): Promise<WorkflowReturnReceipt | null> {
    const receipt = this.getExact({ ...input, kind: 'workflow-return' });
    return receipt?.kind === 'workflow-return' && (receipt.status === 'executing' || receipt.expiresAt.getTime() > input.now.getTime())
      ? receipt
      : null;
  }

  async updateWorkflowReturnPhase(input: { userId: number; chatId: number; id: string; phase: WorkflowReturnPhase; expiresAt: Date; now: Date }): Promise<'updated' | 'expired' | 'superseded' | 'terminal'> {
    const receipt = this.getCurrent(`${input.userId}:${input.chatId}:workflow-return`);
    if (receipt?.kind !== 'workflow-return' || receipt.id !== input.id) return 'superseded';
    if (receipt.status !== 'pending') return 'terminal';
    if (receipt.expiresAt.getTime() <= input.now.getTime()) return 'expired';
    const updated: WorkflowReturnReceipt = {
      ...receipt,
      expiresAt: new Date(input.expiresAt),
      payload: { ...receipt.payload, phase: input.phase },
    };
    if (!isHomeActionReceipt(updated)) throw new RangeError('Invalid workflow return phase update');
    this.save(updated);
    return 'updated';
  }

  async updateWorkflowReturnDeliveryStage(input: { userId: number; chatId: number; id: string; stage: Exclude<WorkflowDeliveryStage, 'pending'>; now: Date }): Promise<'updated' | 'expired' | 'superseded' | 'terminal'> {
    const receipt = this.getExact({ ...input, kind: 'workflow-return' });
    if (receipt?.kind !== 'workflow-return' || receipt.userId !== input.userId || receipt.chatId !== input.chatId) return 'superseded';
    if (receipt.status !== 'executing' && receipt.status !== 'returned') return 'terminal';
    if (receipt.expiresAt.getTime() <= input.now.getTime()) return 'expired';
    const currentStage = receipt.payload.deliveryStage ?? 'pending';
    if (!canTransitionWorkflowDeliveryStage(currentStage, input.stage)) return 'terminal';
    const updated: WorkflowReturnReceipt = {
      ...receipt,
      payload: { ...receipt.payload, deliveryStage: input.stage },
    };
    if (!isHomeActionReceipt(updated)) throw new RangeError('Invalid workflow return delivery stage update');
    this.save(updated);
    return 'updated';
  }

  async claimWorkflowReturn(input: { userId: number; chatId: number; id: string; now: Date }): Promise<WorkflowClaimResult> {
    const receipt = this.getCurrent(`${input.userId}:${input.chatId}:workflow-return`);
    if (receipt?.kind !== 'workflow-return' || receipt.id !== input.id) return { kind: 'superseded' };
    if (receipt.status === 'executing') return { kind: 'resumable', receipt };
    if (receipt.status === 'returned') return { kind: 'returned', receipt };
    if (receipt.status === 'completed') return { kind: 'terminal' };
    if (receipt.expiresAt.getTime() <= input.now.getTime()) return { kind: 'expired' };
    const executing: WorkflowReturnReceipt = { ...receipt, status: 'executing' };
    this.save(executing);
    return { kind: 'claimed', receipt: clone(executing) as WorkflowReturnReceipt };
  }

  async claimWorkflowReturnExact(input: { userId: number; chatId: number; id: string; now: Date }): Promise<WorkflowClaimResult> {
    const receipt = this.getExact({ ...input, kind: 'workflow-return' });
    if (receipt?.kind !== 'workflow-return') return { kind: 'superseded' };
    if (receipt.status === 'executing') return { kind: 'resumable', receipt };
    if (receipt.status === 'returned') return { kind: 'returned', receipt };
    if (receipt.status === 'completed') return { kind: 'terminal' };
    if (receipt.expiresAt.getTime() <= input.now.getTime()) return { kind: 'expired' };
    if (this.current.get(keyOf(receipt)) !== identityOf(receipt)) return { kind: 'superseded' };
    const executing: WorkflowReturnReceipt = { ...receipt, status: 'executing' };
    this.save(executing);
    return { kind: 'claimed', receipt: clone(executing) as WorkflowReturnReceipt };
  }

  async claimFeatureMutation(input: { userId: number; chatId: number; id: string; now: Date }): Promise<FeatureMutationClaimResult> {
    return this.transactionSync(() => {
      const receipt = this.getCurrent(`${input.userId}:${input.chatId}:workflow-return`);
      if (receipt?.kind !== 'workflow-return' || receipt.id !== input.id) return { kind: 'superseded' } as const;
      if (receipt.payload.workflow !== 'feature' || !receipt.payload.operation) return { kind: 'mismatched' } as const;
      if (receipt.status !== 'pending') return { kind: 'terminal' } as const;
      if (receipt.expiresAt.getTime() <= input.now.getTime()) return { kind: 'expired' } as const;
      if (this.users?.readRoleForHomeAction(input.userId) !== 'admin') return { kind: 'unauthorized' } as const;
      const running: WorkflowReturnReceipt = {
        ...receipt,
        status: 'executing',
        expiresAt: new Date(input.now.getTime() + 24 * 60 * 60 * 1_000),
        payload: { ...receipt.payload, phase: 'running' },
      };
      if (!isHomeActionReceipt(running) || !running.payload.operation) throw new RangeError('Invalid feature mutation receipt');
      this.save(running);
      return { kind: 'claimed', receipt: clone(running) as WorkflowReturnReceipt, operation: running.payload.operation } as const;
    });
  }

  async finishWorkflowReturn(input: { userId: number; chatId: number; id: string; outcome: 'returned' | 'completed'; now: Date }): Promise<'finished' | 'superseded' | 'terminal'> {
    const receipt = this.getExact({ ...input, kind: 'workflow-return' });
    if (receipt?.kind !== 'workflow-return' || receipt.userId !== input.userId || receipt.chatId !== input.chatId) return 'superseded';
    if (receipt.status === 'completed') return 'terminal';
    if (receipt.status !== 'executing' && !(receipt.status === 'returned' && input.outcome === 'completed')) {
      return receipt.status === 'returned' ? 'terminal' : 'superseded';
    }
    this.save({ ...receipt, status: input.outcome });
    return 'finished';
  }

  private async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const receipts = this.snapshotReceipts();
    try { return await operation(); } catch (error) { this.restoreReceipts(receipts); throw error; }
  }

  private transactionSync<T>(operation: () => T): T {
    const receipts = this.snapshotReceipts();
    try { return operation(); } catch (error) { this.restoreReceipts(receipts); throw error; }
  }

  private getCurrent(slot: string): HomeActionReceipt | null {
    const identity = this.current.get(slot);
    return identity ? decode(this.receipts.get(identity)) : decode(this.receipts.get(slot));
  }

  private getExact(input: Pick<HomeActionReceipt, 'userId' | 'chatId' | 'kind' | 'id'>): HomeActionReceipt | null {
    return decode(this.receipts.get(identityOf(input)));
  }

  private setCurrent(receipt: HomeActionReceipt): void {
    const identity = identityOf(receipt);
    this.receipts.set(identity, clone(receipt));
    this.current.set(keyOf(receipt), identity);
  }

  private save(receipt: HomeActionReceipt): void {
    this.receipts.set(identityOf(receipt), clone(receipt));
  }

  private snapshotReceipts(): { receipts: Map<string, HomeActionReceipt>; current: Map<string, string> } {
    return {
      receipts: new Map([...this.receipts].map(([key, receipt]) => [key, clone(receipt)])),
      current: new Map(this.current),
    };
  }

  private restoreReceipts(snapshot: { receipts: Map<string, HomeActionReceipt>; current: Map<string, string> }): void {
    this.receipts.clear();
    for (const [key, receipt] of snapshot.receipts) this.receipts.set(key, receipt);
    this.current.clear();
    for (const [key, id] of snapshot.current) this.current.set(key, id);
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import type { LocaleCatalog } from '../../locales';
import { BeginWorkflowReturnUseCase } from '../application/begin-workflow-return.use-case';
import { WORKFLOW_RETURN_TTL_MS } from '../application/begin-workflow-return.use-case';
import {
  HOME_ACTION_REPOSITORY,
  type HomeActionRepositoryPort,
} from '../application/ports/home-action-repository.port';
import { naturalWorkflowOrigin } from '../application/resolve-workflow-origin.use-case';
import type { HomeView } from '../domain/home-session';
import type { Locale } from '../domain/locale';
import type { Role } from '../domain/role';
import type { ExternalWorkflow, WorkflowReturnReceipt } from '../domain/workflow-return';
import { WorkflowDraftRegistry } from './workflow-draft.registry';
import { WorkflowOperationQueue } from './workflow-operation.queue';
import type { TelegramContext } from './telegram-context';

export type WorkflowOrigin =
  | { source: 'captured'; view: HomeView; sessionToken: string }
  | { source: 'natural-parent' };

export interface WorkflowLaunch {
  receipt: WorkflowReturnReceipt;
}

export interface CurrentWorkflowIdentity {
  userId: number;
  chatId: number;
  locale: Locale;
  role: Role;
  catalog: LocaleCatalog;
}

export type LeaveForHomeResult = 'opened' | 'no-workflow' | 'not-opened' | 'stale' | 'ignored';
export type HeadlessWorkflowCompletionResult = 'completed' | 'resumable' | 'no-workflow' | 'ignored';

@Injectable()
export class WorkflowEntryCoordinator {
  constructor(
    @Inject(BeginWorkflowReturnUseCase) private readonly beginWorkflow: BeginWorkflowReturnUseCase,
    @Inject(WorkflowDraftRegistry) private readonly drafts: WorkflowDraftRegistry,
    @Inject(WorkflowOperationQueue) private readonly operations: WorkflowOperationQueue,
    @Inject(HOME_ACTION_REPOSITORY) private readonly actions: HomeActionRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async begin(
    ctx: TelegramContext,
    workflow: ExternalWorkflow,
    origin: WorkflowOrigin,
  ): Promise<WorkflowReturnReceipt | null> {
    const identity = currentWorkflowIdentity(ctx);
    if (!identity) return null;

    return this.operations.run(identity.userId, identity.chatId, async () => {
      const result = await this.beginWorkflow.execute({
        userId: identity.userId,
        chatId: identity.chatId,
        workflow,
        origin: origin.source === 'captured' ? origin.view : naturalWorkflowOrigin(workflow),
        originSource: origin.source,
        sessionToken: origin.source === 'captured' ? origin.sessionToken : null,
      });
      if (result.replaced?.payload.phase === 'cancellable') {
        await this.drafts.cancelExact(result.replaced);
      }
      return result.receipt;
    });
  }

  async leaveForHome(
    ctx: TelegramContext,
    promoteFreshDestination: () => Promise<boolean>,
  ): Promise<LeaveForHomeResult> {
    const identity = currentWorkflowIdentity(ctx);
    if (!identity) return 'ignored';

    return this.operations.run(identity.userId, identity.chatId, async () => {
      const now = this.clock.now();
      const current = await this.actions.findWorkflowReturn({
        userId: identity.userId,
        chatId: identity.chatId,
        now,
      });
      if (!current) return 'no-workflow';

      const claim = await this.actions.claimWorkflowReturn({
        userId: identity.userId,
        chatId: identity.chatId,
        id: current.id,
        now,
      });
      if (claim.kind === 'expired' || claim.kind === 'superseded') return 'stale';
      if (claim.kind === 'returned' || claim.kind === 'terminal') return 'no-workflow';
      if (claim.kind !== 'claimed' && claim.kind !== 'resumable') return 'stale';
      const receipt = claim.receipt;

      if (claim.kind === 'claimed' && receipt.payload.phase === 'cancellable') {
        await this.drafts.cancelExact(receipt);
      }
      if (!await promoteFreshDestination()) return 'not-opened';

      await this.actions.finishWorkflowReturn({
        userId: identity.userId,
        chatId: identity.chatId,
        id: receipt.id,
        outcome: 'returned',
        now: this.clock.now(),
      });
      return 'opened';
    });
  }

  /**
   * Advances a receipt before an irreversible operation starts.  Keeping this
   * at the coordinator boundary makes a callback replay unable to start the
   * operation after the durable receipt has already left its cancellable
   * phase.
   */
  async markRunning(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
  ): Promise<boolean> {
    const identity = currentWorkflowIdentity(ctx);
    if (!identity) return false;
    if (receipt.userId !== identity.userId || receipt.chatId !== identity.chatId) return false;

    return this.operations.run(identity.userId, identity.chatId, async () => {
      const now = this.clock.now();
      const result = await this.actions.updateWorkflowReturnPhase({
        userId: identity.userId,
        chatId: identity.chatId,
        id: receipt.id,
        phase: 'running',
        now,
        expiresAt: new Date(now.getTime() + WORKFLOW_RETURN_TTL_MS),
      });
      return result === 'updated';
    });
  }

  /**
   * Completes a workflow without a grammY context after process recovery.
   * Each external delivery attempt is recorded before it starts, so recovery
   * can prefer an unfinished compensation over repeating a DM or Home notice.
   */
  async completeHeadless(input: {
    identity: CurrentWorkflowIdentity;
    workflow: ExternalWorkflow;
    deliver(): Promise<void>;
    /**
     * A resumable receipt may have lost its one direct delivery attempt.
     * The supplied notice preserves that terminal outcome in the restored
     * Home without retrying the direct message.
     */
    restore(receipt: WorkflowReturnReceipt, notice?: string): Promise<boolean>;
    recoveryNotice?: string;
  }): Promise<HeadlessWorkflowCompletionResult> {
    const { identity } = input;
    return this.operations.run(identity.userId, identity.chatId, async () => {
      const current = await this.actions.findWorkflowReturn({
        userId: identity.userId,
        chatId: identity.chatId,
        now: this.clock.now(),
      });
      if (!current) return 'no-workflow';
      if (current.payload.workflow !== input.workflow) return 'no-workflow';

      const claim = await this.actions.claimWorkflowReturn({
        userId: identity.userId,
        chatId: identity.chatId,
        id: current.id,
        now: this.clock.now(),
      });
      if (claim.kind === 'expired' || claim.kind === 'superseded' || claim.kind === 'terminal') {
        return 'no-workflow';
      }
      if (claim.kind !== 'claimed' && claim.kind !== 'resumable' && claim.kind !== 'returned') {
        return 'no-workflow';
      }
      const receipt = claim.receipt;

      if (claim.kind === 'claimed' && receipt.payload.phase === 'cancellable') {
        await this.drafts.cancelExact(receipt);
      }
      let deliveryStage = receipt.payload.deliveryStage ?? 'pending';

      // A user who returned while the restart ran already has a fresh Home.
      // Do not replace that newer session or attempt a previously unrecorded
      // delivery; only a durably confirmed outcome may finish this receipt.
      if (claim.kind === 'returned') {
        if (deliveryStage !== 'delivered') return 'resumable';
        const finish = await this.actions.finishWorkflowReturn({
          userId: identity.userId,
          chatId: identity.chatId,
          id: receipt.id,
          outcome: 'completed',
          now: this.clock.now(),
        });
        return finish === 'finished' ? 'completed' : 'resumable';
      }

      if (deliveryStage === 'pending') {
        if (!await this.persistDeliveryStage(identity, receipt, 'direct-attempted')) return 'resumable';
        deliveryStage = 'direct-attempted';
        let delivered = false;
        try {
          await input.deliver();
          delivered = true;
        } catch {
          // The result may still have reached Telegram; do not send it again.
        }
        if (delivered && await this.persistDeliveryStage(identity, receipt, 'delivered')) {
          deliveryStage = 'delivered';
        }
      }

      if (claim.kind !== 'claimed' && claim.kind !== 'resumable') return 'no-workflow';

      if (deliveryStage === 'direct-attempted' || deliveryStage === 'needs-notice') {
        if (!input.recoveryNotice) return 'resumable';
        if (!await this.persistDeliveryStage(identity, receipt, 'notice-attempted')) return 'resumable';
        if (!await input.restore(receipt, input.recoveryNotice)) return 'resumable';
        if (!await this.persistDeliveryStage(identity, receipt, 'delivered')) return 'resumable';
      } else if (deliveryStage === 'notice-attempted') {
        return 'resumable';
      } else if (!await input.restore(receipt, undefined)) {
        return 'resumable';
      }
      const finish = await this.actions.finishWorkflowReturn({
        userId: identity.userId,
        chatId: identity.chatId,
        id: receipt.id,
        outcome: 'completed',
        now: this.clock.now(),
      });
      return finish === 'finished' ? 'completed' : 'resumable';
    });
  }

  private async persistDeliveryStage(
    identity: CurrentWorkflowIdentity,
    receipt: WorkflowReturnReceipt,
    stage: 'direct-attempted' | 'notice-attempted' | 'delivered',
  ): Promise<boolean> {
    try {
      const result = await this.actions.updateWorkflowReturnDeliveryStage({
        userId: identity.userId,
        chatId: identity.chatId,
        id: receipt.id,
        stage,
        now: this.clock.now(),
      });
      return result === 'updated';
    } catch {
      return false;
    }
  }
}

export function currentWorkflowIdentity(ctx: TelegramContext): CurrentWorkflowIdentity | null {
  const userId = ctx.from?.id;
  const chat = ctx.chat;
  const state = ctx.localeState;
  if (!Number.isSafeInteger(userId) || chat?.type !== 'private' || !state
    || state.user.telegramId !== userId) return null;
  return {
    userId,
    chatId: chat.id,
    locale: state.locale,
    role: state.user.role,
    catalog: state.catalog,
  };
}

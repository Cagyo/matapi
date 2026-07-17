import { Injectable } from '@nestjs/common';
import { Composer } from 'grammy';
import { ClaimWorkflowReturnUseCase } from '../application/claim-workflow-return.use-case';
import { CompleteWorkflowReturnUseCase } from '../application/complete-workflow-return.use-case';
import { RestoreWorkflowOriginUseCase } from '../application/restore-workflow-origin.use-case';
import {
  parseWorkflowReturnCallback,
  type WorkflowReturnDestination,
  type WorkflowReturnReceipt,
} from '../domain/workflow-return';
import { WorkflowDraftRegistry } from './workflow-draft.registry';
import {
  currentWorkflowIdentity,
  type CurrentWorkflowIdentity,
  type WorkflowLaunch,
} from './workflow-entry.coordinator';
import { WorkflowNavigationPresenter } from './workflow-navigation.presenter';
import { WorkflowOperationQueue } from './workflow-operation.queue';
import { RoleMiddleware } from './role.middleware';
import type { TelegramContext } from './telegram-context';
import type { TelegramHandler } from './telegram-handler';

const WORKFLOW_RETURN_CALLBACK = /^wr:[A-Za-z0-9_-]{16}:[oh]$/;

export interface WorkflowCompletionPresentation {
  deliver(): Promise<void>;
  failureNotice: string;
}

@Injectable()
export class WorkflowNavigationHandler implements TelegramHandler {
  constructor(
    private readonly guard: RoleMiddleware,
    private readonly claimWorkflow: ClaimWorkflowReturnUseCase,
    private readonly completeWorkflow: CompleteWorkflowReturnUseCase,
    private readonly restoreWorkflow: RestoreWorkflowOriginUseCase,
    private readonly drafts: WorkflowDraftRegistry,
    private readonly operations: WorkflowOperationQueue,
    private readonly presenter: WorkflowNavigationPresenter,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.callbackQuery(WORKFLOW_RETURN_CALLBACK, this.guard.registered, async (ctx) => {
      await this.acknowledgeOnce(ctx);
      const action = parseWorkflowReturnCallback(ctx.callbackQuery?.data ?? '');
      const identity = currentWorkflowIdentity(ctx);
      if (!action || !identity) return;
      await this.operations.run(identity.userId, identity.chatId, async () => {
        const claim = await this.claimWorkflow.execute({
          userId: identity.userId,
          chatId: identity.chatId,
          id: action.receiptId,
        });
        if (claim.kind !== 'claimed' && claim.kind !== 'resumable') return;

        let notice: string | undefined;
        if (claim.kind === 'claimed' && claim.receipt.payload.phase === 'cancellable') {
          const cleanup = await this.drafts.cancelExact(claim.receipt);
          if (cleanup === 'missing') notice = identity.catalog.common.interrupted;
        }
        const restored = await this.restore(
          ctx,
          identity,
          claim.receipt,
          action.destination,
          notice,
        );
        if (!restored) return;
        await this.completeWorkflow.execute({
          userId: identity.userId,
          chatId: identity.chatId,
          id: claim.receipt.id,
          outcome: 'returned',
        });
      });
    });
  }

  async complete(
    ctx: TelegramContext,
    launch: WorkflowLaunch,
    presentation: WorkflowCompletionPresentation,
  ): Promise<void> {
    const identity = currentWorkflowIdentity(ctx);
    if (launch.receipt.userId !== identity?.userId
      || launch.receipt.chatId !== identity.chatId) return;

    await this.operations.run(identity.userId, identity.chatId, async () => {
      const claim = await this.claimWorkflow.execute({
        userId: identity.userId,
        chatId: identity.chatId,
        id: launch.receipt.id,
      });
      if (claim.kind === 'superseded' && launch.receipt.payload.phase === 'running') {
        await presentation.deliver().catch(() => undefined);
        return;
      }
      if (claim.kind === 'returned') {
        try {
          await presentation.deliver();
        } catch {
          return;
        }
        await this.completeWorkflow.execute({
          userId: identity.userId,
          chatId: identity.chatId,
          id: claim.receipt.id,
          outcome: 'completed',
        });
        return;
      }
      if (claim.kind !== 'claimed' && claim.kind !== 'resumable') return;

      if (claim.kind === 'claimed' && claim.receipt.payload.phase === 'cancellable') {
        await this.drafts.cancelExact(claim.receipt);
      }
      let notice: string | undefined;
      if (claim.kind === 'claimed') {
        try {
          await presentation.deliver();
        } catch {
          notice = presentation.failureNotice;
        }
      }
      const restored = await this.restore(ctx, identity, claim.receipt, 'origin', notice);
      if (!restored) return;
      await this.completeWorkflow.execute({
        userId: identity.userId,
        chatId: identity.chatId,
        id: claim.receipt.id,
        outcome: 'completed',
      });
    });
  }

  private async restore(
    ctx: TelegramContext,
    identity: CurrentWorkflowIdentity,
    receipt: WorkflowReturnReceipt,
    destination: WorkflowReturnDestination,
    notice?: string,
  ): Promise<boolean> {
    try {
      const result = await this.restoreWorkflow.execute({
        userId: identity.userId,
        chatId: identity.chatId,
        locale: identity.locale,
        role: identity.role,
        workflow: receipt.payload.workflow,
        requested: destination === 'home'
          ? { kind: 'home', checking: false }
          : receipt.payload.origin,
        originSource: destination === 'home' ? 'captured' : receipt.payload.originSource,
        notice,
      });
      if (result.kind === 'opened') return true;
    } catch {
      // Compensation below keeps the durable executing receipt resumable.
    }
    await this.compensate(ctx, identity, receipt, destination);
    return false;
  }

  private async compensate(
    ctx: TelegramContext,
    identity: CurrentWorkflowIdentity,
    receipt: WorkflowReturnReceipt,
    destination: WorkflowReturnDestination,
  ): Promise<void> {
    const replyMarkup = this.presenter.retryReturnKeyboard(receipt, {
      label: identity.catalog.home.recovery.openNewHome,
      destination,
    });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: replyMarkup });
    } catch {
      await ctx.reply(identity.catalog.home.recovery.unavailable, {
        reply_markup: replyMarkup,
      }).catch(() => undefined);
    }
  }

  private async acknowledgeOnce(ctx: TelegramContext): Promise<void> {
    if (ctx.homeCallbackAcknowledged) return;
    await ctx.answerCallbackQuery().catch(() => undefined);
    ctx.homeCallbackAcknowledged = true;
  }
}

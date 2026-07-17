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
   * A claimed receipt is allowed one result-delivery attempt. If reopening
   * its origin later fails, a resumable retry re-attempts only restoration;
   * it never turns into the legacy broadcast path or sends the result twice.
   */
  async completeHeadless(input: {
    identity: CurrentWorkflowIdentity;
    workflow: ExternalWorkflow;
    deliver(): Promise<void>;
    restore(receipt: WorkflowReturnReceipt): Promise<boolean>;
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

      if (claim.kind === 'claimed' && claim.receipt.payload.phase === 'cancellable') {
        await this.drafts.cancelExact(claim.receipt);
      }
      if (claim.kind === 'claimed') {
        await input.deliver().catch(() => undefined);
      }

      // A user who returned while the restart ran already has a fresh Home.
      // Send the terminal result once, but do not replace that newer session.
      if (claim.kind === 'returned') {
        await input.deliver().catch(() => undefined);
        const finish = await this.actions.finishWorkflowReturn({
          userId: identity.userId,
          chatId: identity.chatId,
          id: claim.receipt.id,
          outcome: 'completed',
          now: this.clock.now(),
        });
        return finish === 'finished' ? 'completed' : 'resumable';
      }

      if (claim.kind !== 'claimed' && claim.kind !== 'resumable') return 'no-workflow';

      if (!await input.restore(claim.receipt)) return 'resumable';
      const finish = await this.actions.finishWorkflowReturn({
        userId: identity.userId,
        chatId: identity.chatId,
        id: claim.receipt.id,
        outcome: 'completed',
        now: this.clock.now(),
      });
      return finish === 'finished' ? 'completed' : 'resumable';
    });
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

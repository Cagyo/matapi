import { Injectable } from '@nestjs/common';
import type { LocaleCatalog } from '../../locales';
import { BeginWorkflowReturnUseCase } from '../application/begin-workflow-return.use-case';
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

@Injectable()
export class WorkflowEntryCoordinator {
  constructor(
    private readonly beginWorkflow: BeginWorkflowReturnUseCase,
    private readonly drafts: WorkflowDraftRegistry,
    private readonly operations: WorkflowOperationQueue,
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

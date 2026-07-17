import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import type { HomeView } from '../domain/home-session';
import {
  HOME_TOKEN_GENERATOR,
  type HomeTokenGeneratorPort,
} from '../domain/ports/home-token-generator.port';
import type { ExternalWorkflow, WorkflowReturnReceipt } from '../domain/workflow-return';
import {
  HOME_ACTION_REPOSITORY,
  type HomeActionRepositoryPort,
} from './ports/home-action-repository.port';

export const WORKFLOW_RETURN_TTL_MS = 24 * 60 * 60 * 1_000;

export interface BeginWorkflowReturnInput {
  userId: number;
  chatId: number;
  workflow: ExternalWorkflow;
  origin: HomeView;
  originSource: 'captured' | 'natural-parent';
  sessionToken: string | null;
}

export interface BeginWorkflowReturnResult {
  receipt: WorkflowReturnReceipt;
  replaced: WorkflowReturnReceipt | null;
}

@Injectable()
export class BeginWorkflowReturnUseCase {
  constructor(
    @Inject(HOME_ACTION_REPOSITORY) private readonly actions: HomeActionRepositoryPort,
    @Inject(HOME_TOKEN_GENERATOR) private readonly tokens: HomeTokenGeneratorPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(input: BeginWorkflowReturnInput): Promise<BeginWorkflowReturnResult> {
    const now = this.clock.now();
    const receipt: WorkflowReturnReceipt = {
      id: this.tokens.generate(),
      userId: input.userId,
      chatId: input.chatId,
      kind: 'workflow-return',
      sessionToken: input.sessionToken,
      status: 'pending',
      expiresAt: new Date(now.getTime() + WORKFLOW_RETURN_TTL_MS),
      payload: {
        workflow: input.workflow,
        phase: 'cancellable',
        originSource: input.originSource,
        origin: input.origin,
        deliveryStage: 'pending',
      },
    };
    const replaced = await this.actions.beginWorkflowReturn(receipt);
    return { receipt, replaced };
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import type { WorkflowReturnPhase } from '../domain/workflow-return';
import { WORKFLOW_RETURN_TTL_MS } from './begin-workflow-return.use-case';
import {
  HOME_ACTION_REPOSITORY,
  type HomeActionRepositoryPort,
} from './ports/home-action-repository.port';

export interface UpdateWorkflowReturnInput {
  userId: number;
  chatId: number;
  id: string;
  phase: WorkflowReturnPhase;
}

export type UpdateWorkflowReturnResult = Awaited<ReturnType<HomeActionRepositoryPort['updateWorkflowReturnPhase']>>;

@Injectable()
export class UpdateWorkflowReturnUseCase {
  constructor(
    @Inject(HOME_ACTION_REPOSITORY) private readonly actions: HomeActionRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(input: UpdateWorkflowReturnInput): Promise<UpdateWorkflowReturnResult> {
    const now = this.clock.now();
    return this.actions.updateWorkflowReturnPhase({
      ...input,
      now,
      expiresAt: new Date(now.getTime() + WORKFLOW_RETURN_TTL_MS),
    });
  }
}

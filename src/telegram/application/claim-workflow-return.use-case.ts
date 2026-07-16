import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import {
  HOME_ACTION_REPOSITORY,
  type HomeActionRepositoryPort,
  type WorkflowClaimResult,
} from './ports/home-action-repository.port';

export interface ClaimWorkflowReturnInput {
  userId: number;
  chatId: number;
  id: string;
}

@Injectable()
export class ClaimWorkflowReturnUseCase {
  constructor(
    @Inject(HOME_ACTION_REPOSITORY) private readonly actions: HomeActionRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(input: ClaimWorkflowReturnInput): Promise<WorkflowClaimResult> {
    return this.actions.claimWorkflowReturn({ ...input, now: this.clock.now() });
  }
}

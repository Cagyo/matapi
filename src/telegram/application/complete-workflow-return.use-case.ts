import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import {
  HOME_ACTION_REPOSITORY,
  type HomeActionRepositoryPort,
} from './ports/home-action-repository.port';

export interface CompleteWorkflowReturnInput {
  userId: number;
  chatId: number;
  id: string;
  outcome: 'returned' | 'completed';
}

export type CompleteWorkflowReturnResult = Awaited<ReturnType<HomeActionRepositoryPort['finishWorkflowReturn']>>;

@Injectable()
export class CompleteWorkflowReturnUseCase {
  constructor(
    @Inject(HOME_ACTION_REPOSITORY) private readonly actions: HomeActionRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(input: CompleteWorkflowReturnInput): Promise<CompleteWorkflowReturnResult> {
    return this.actions.finishWorkflowReturn({ ...input, now: this.clock.now() });
  }
}

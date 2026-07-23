import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import {
  HOME_ACTION_REPOSITORY,
  type FeatureMutationClaimResult,
  type HomeActionRepositoryPort,
} from './ports/home-action-repository.port';

export interface ClaimFeatureMutationInput {
  userId: number;
  chatId: number;
  id: string;
}

/** Claims the receipt and rechecks the current role in one repository transaction. */
@Injectable()
export class ClaimFeatureMutationUseCase {
  constructor(
    @Inject(HOME_ACTION_REPOSITORY) private readonly actions: HomeActionRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(input: ClaimFeatureMutationInput): Promise<FeatureMutationClaimResult> {
    return this.actions.claimFeatureMutation({ ...input, now: this.clock.now() });
  }
}

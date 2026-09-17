import { Inject, Injectable } from '@nestjs/common';
import { LiveViewSettingsBusyError } from '../../camera/domain/errors/live-view-settings-busy.error';
import { LiveViewSettingsStateError } from '../../camera/domain/errors/live-view-settings-state.error';
import {
  createLiveViewSettingsCandidate,
  type LiveViewSettingsCandidate,
} from '../../camera/domain/live-view-settings';
import type { LiveViewSettingsJob } from '../../camera/domain/live-view-settings-job';
import type { LiveViewSettingsStorePort } from '../../camera/domain/ports/live-view-settings-store.port';
import { CLOCK, type ClockPort } from '../../events/domain/ports/clock.port';
import {
  HOME_ACTION_REPOSITORY,
  type HomeActionRepositoryPort,
} from './ports/home-action-repository.port';

export interface ClaimLiveViewSettingsMutationInput {
  readonly userId: number;
  readonly chatId: number;
  readonly receiptId: string;
  readonly jobId: string;
  readonly expectedGeneration: number;
  readonly candidate: LiveViewSettingsCandidate;
}

@Injectable()
export class ClaimLiveViewSettingsMutationUseCase {
  constructor(
    @Inject(HOME_ACTION_REPOSITORY) private readonly actions: HomeActionRepositoryPort,
    private readonly settings: LiveViewSettingsStorePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(input: ClaimLiveViewSettingsMutationInput): Promise<LiveViewSettingsJob> {
    const candidate = createLiveViewSettingsCandidate(input.candidate);
    const committed = await this.settings.readCommitted();
    if (committed.generation !== input.expectedGeneration) {
      throw new LiveViewSettingsStateError();
    }

    const result = await this.actions.claimLiveViewSettingsMutation({
      ...input,
      candidate,
      now: this.clock.now(),
    });
    if (result.kind === 'claimed') return result.job;
    if (result.kind === 'busy') throw new LiveViewSettingsBusyError();
    throw new LiveViewSettingsStateError();
  }
}

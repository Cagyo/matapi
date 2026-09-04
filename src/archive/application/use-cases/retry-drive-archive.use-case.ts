import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../../events/domain/ports/clock.port';
import { ArchiveWakeService } from '../archive-wake.service';
import {
  DRIVE_FOLDER_RESERVATION_REPOSITORY,
  type DriveFolderReservationRepositoryPort,
} from '../ports/drive-folder-reservation-repository.port';
import {
  ARCHIVE_PROVIDER_STATE_REPOSITORY,
  type ArchiveProviderState,
  type ArchiveProviderStateRepositoryPort,
} from '../ports/archive-provider-state-repository.port';

export type RetryDriveArchiveResult =
  | 'scheduled'
  | 'stale'
  | 'nothing-blocked'
  | 'automatic-quota-probe'
  | 'reauthorize';

export interface RetryDriveArchiveInput {
  generationId: string;
  observedProviderRevision: number;
}

/** The only retry actions that are durable against the current provider gate state. */
export type DriveArchiveRetryEligibility =
  | 'branch-revalidation'
  | 'provider-probe'
  | 'automatic-quota-probe'
  | 'reauthorize'
  | 'nothing-blocked';

/**
 * Classifies a fresh provider snapshot before presenting or scheduling a retry.
 * A provider probe is claimable only while its cooldown fence is clear.
 */
export function classifyDriveArchiveRetry(state: ArchiveProviderState): DriveArchiveRetryEligibility {
  if (state.blockReason === 'quota_exhausted') return 'automatic-quota-probe';
  if (state.blockReason === 'reauthorization_required') return 'reauthorize';
  if ((state.blockReason === 'account_creation_limit' || state.blockReason === 'policy_blocked')
    && state.cooldownUntilMs === null) return 'provider-probe';
  return isClear(state) ? 'branch-revalidation' : 'nothing-blocked';
}

/** Schedules bounded recovery work without accepting a remote object or folder ID. */
@Injectable()
export class RetryDriveArchiveUseCase {
  constructor(
    @Inject(ARCHIVE_PROVIDER_STATE_REPOSITORY)
    private readonly providerState: ArchiveProviderStateRepositoryPort,
    @Inject(DRIVE_FOLDER_RESERVATION_REPOSITORY)
    private readonly reservations: Pick<
      DriveFolderReservationRepositoryPort,
      'requestNextBlockedRevalidation'
    >,
    @Inject(CLOCK) private readonly clock: Pick<ClockPort, 'now'>,
    private readonly wake: ArchiveWakeService,
  ) {}

  async execute(input: RetryDriveArchiveInput): Promise<RetryDriveArchiveResult> {
    const current = await this.providerState.load();
    if (current.generationId !== input.generationId
      || current.revision !== input.observedProviderRevision) return 'stale';

    const eligibility = classifyDriveArchiveRetry(current);
    if (eligibility === 'automatic-quota-probe') return eligibility;
    if (eligibility === 'reauthorize') return eligibility;
    if (eligibility === 'provider-probe') {
      const blockReason = current.blockReason;
      if (blockReason !== 'account_creation_limit' && blockReason !== 'policy_blocked') {
        return 'nothing-blocked';
      }
      const scheduled = await this.providerState.requestProbe({
        generationId: input.generationId,
        expectedRevision: input.observedProviderRevision,
        allowedBlockReasons: [blockReason],
        nowMs: this.clock.now().getTime(),
      });
      if (!scheduled) return 'stale';
      this.wake.wake();
      return 'scheduled';
    }

    if (eligibility !== 'branch-revalidation') return 'nothing-blocked';
    const requested = await this.reservations.requestNextBlockedRevalidation({
      generationId: input.generationId,
      nowMs: this.clock.now().getTime(),
    });
    if (requested === null) return 'nothing-blocked';
    this.wake.wake();
    return 'scheduled';
  }
}

function isClear(state: ArchiveProviderState): boolean {
  return state.operationClass === null
    && state.failureClass === null
    && state.failureStreak === 0
    && state.cooldownUntilMs === null
    && state.blockReason === null;
}

import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../../events/domain/ports/clock.port';
import {
  ArchiveProviderGateService,
  type ArchiveProviderAdmission,
} from '../archive-provider-gate.service';
import {
  ARCHIVE_ARTIFACT_REPOSITORY,
  type ArchiveArtifactRepositoryPort,
} from '../ports/archive-artifact-repository.port';
import {
  DRIVE_QUOTA_PROBE,
  type DriveQuotaProbePort,
} from '../ports/drive-quota-probe.port';
import type { DriveConnection } from '../../domain/drive-connection.entity';
import type { DriveQuota } from '../ports/drive-account.port';

export type ProbeDriveQuotaRecoveryResult = 'recovered' | 'still-blocked' | 'stale';

/** Performs one bounded live quota read after winning the durable quota-probe claim. */
@Injectable()
export class ProbeDriveQuotaRecoveryUseCase {
  constructor(
    @Inject(ARCHIVE_ARTIFACT_REPOSITORY)
    private readonly artifacts: Pick<
      ArchiveArtifactRepositoryPort,
      'readNextEligibleTransferSize'
    >,
    @Inject(DRIVE_QUOTA_PROBE)
    private readonly quota: DriveQuotaProbePort,
    private readonly providerGate: Pick<
      ArchiveProviderGateService,
      'claimRecoveryProbe' | 'recordQuotaOutcome'
    >,
    @Inject(CLOCK) private readonly clock: Pick<ClockPort, 'now'>,
  ) {}

  async execute(
    connection: DriveConnection,
    admission: Extract<ArchiveProviderAdmission, { kind: 'probe' }>,
    signal: AbortSignal,
  ): Promise<ProbeDriveQuotaRecoveryResult> {
    throwIfAborted(signal);
    if (connection.status !== 'active'
      || admission.reason !== 'quota'
      || admission.generationId !== connection.id) {
      return 'stale';
    }
    const fence = {
      id: connection.id,
      revision: connection.revision,
      status: connection.status,
    } as const;
    const claim = await this.providerGate.claimRecoveryProbe(admission);
    if (claim === null) return 'stale';

    const nowMs = this.clock.now().getTime();
    try {
      const candidateBytes = await this.artifacts.readNextEligibleTransferSize(
        connection.id,
        nowMs,
      );
      const quota = await this.quota.readQuota(connection, signal);
      const availableBytes = readAvailableBytes(quota);
      const recovered = candidateBytes !== null
        && isNonNegativeSafeInteger(candidateBytes)
        && availableBytes !== null
        && availableBytes >= candidateBytes;
      const remainingDeficitBytes = recovered
        ? 0
        : positiveDeficit(candidateBytes, availableBytes);
      await this.providerGate.recordQuotaOutcome(
        connection.id,
        remainingDeficitBytes,
        claim,
        fence,
      );
      return recovered ? 'recovered' : 'still-blocked';
    } catch (_error) {
      await this.providerGate.recordQuotaOutcome(connection.id, 1, claim, fence);
      if (signal.aborted) throw abortReason(signal);
      return 'still-blocked';
    }
  }
}

function readAvailableBytes(quota: DriveQuota): number | null {
  if (quota.limitBytes === null
    || !isNonNegativeSafeInteger(quota.limitBytes)
    || !isNonNegativeSafeInteger(quota.usageBytes)
    || !isNonNegativeSafeInteger(quota.usageInDriveBytes)
    || !isNonNegativeSafeInteger(quota.usageInDriveTrashBytes)
    || quota.usageInDriveBytes + quota.usageInDriveTrashBytes > quota.usageBytes
    || quota.usageBytes > quota.limitBytes) {
    return null;
  }
  return quota.limitBytes - quota.usageBytes;
}

function positiveDeficit(candidateBytes: number | null, availableBytes: number | null): number {
  if (candidateBytes === null
    || availableBytes === null
    || !isNonNegativeSafeInteger(candidateBytes)) return 1;
  return Math.max(1, candidateBytes - availableBytes);
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}

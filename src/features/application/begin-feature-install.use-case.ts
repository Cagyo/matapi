import { Inject, Injectable } from '@nestjs/common';
import { FeatureInstallStartError } from '../domain/errors/feature-install-start.error';
import type { FeatureInstallJob, ManageableFeatureName } from '../domain/manageable-feature';
import {
  FEATURE_CLOCK,
  type FeatureClockPort,
} from '../domain/ports/feature-clock.port';
import {
  FEATURE_INSTALL_CONTROLLER,
  type FeatureInstallControllerPort,
} from '../domain/ports/feature-install-controller.port';
import {
  FEATURE_INSTALL_JOB_REPOSITORY,
  type FeatureInstallJobRepositoryPort,
} from '../domain/ports/feature-install-job.repository.port';
import {
  FEATURE_INSTALL_REQUEST,
  type FeatureInstallRequestPort,
} from '../domain/ports/feature-install-request.port';
import { FeatureInstallRecoveryService } from './feature-install-recovery.service';

export interface BeginFeatureInstallInput {
  id: string;
  feature: ManageableFeatureName;
  requestedByUserId: number;
  requestedInChatId: number;
  workflowReceiptId: string;
  expected: { installed: false; enabled: false };
}

export interface BeginFeatureInstallResult {
  job: FeatureInstallJob;
  stage: 'running';
}

/** Durably queues an install before exposing it to the privileged helper. */
@Injectable()
export class BeginFeatureInstallUseCase {
  constructor(
    @Inject(FEATURE_INSTALL_JOB_REPOSITORY)
    private readonly jobs: FeatureInstallJobRepositoryPort,
    @Inject(FEATURE_INSTALL_REQUEST)
    private readonly requests: FeatureInstallRequestPort,
    @Inject(FEATURE_INSTALL_CONTROLLER)
    private readonly controller: FeatureInstallControllerPort,
    @Inject(FEATURE_CLOCK) private readonly clock: FeatureClockPort,
    private readonly recovery: FeatureInstallRecoveryService,
  ) {}

  async execute(input: BeginFeatureInstallInput): Promise<BeginFeatureInstallResult> {
    const job = await this.jobs.createQueued({ ...input, operation: 'install', now: this.clock.now() });
    const request = { version: 1 as const, jobId: job.id, feature: job.feature };

    try {
      await this.requests.publish(request);
      await this.controller.start();
      const running = await this.jobs.markRunning(job.id, this.clock.now());
      this.recovery.wake();
      return { job: running, stage: 'running' };
    } catch {
      await this.cancelThenTerminalize(job, request);
      throw new FeatureInstallStartError(job.feature);
    }
  }

  private async cancelThenTerminalize(
    job: FeatureInstallJob,
    request: { version: 1; jobId: string; feature: ManageableFeatureName },
  ): Promise<void> {
    try {
      if (await this.requests.cancelUnclaimed(request)) {
        await this.jobs.terminalizeFailure({
          id: job.id,
          failureCode: 'request-publish-failed',
          attentionReason: null,
          preservePreviousState: true,
          now: this.clock.now(),
        });
        return;
      }
    } catch {
      // An unverified cancellation cannot safely clear the active job.
    }
    this.recovery.wake();
  }
}

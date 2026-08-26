import { Inject, Injectable } from '@nestjs/common';
import { FeatureInstallStartError } from '../domain/errors/feature-install-start.error';
import type {
  FeatureInstallJob,
  FeatureInstallOperation,
  ManageableFeatureName,
} from '../domain/manageable-feature';
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
import {
  FEATURE_RUNTIME_LIFECYCLE,
  type FeatureRuntimeLifecycleRegistryPort,
} from '../domain/ports/feature-runtime-lifecycle.port';
import { FeatureInstallRecoveryService } from './feature-install-recovery.service';

export interface BeginFeatureInstallInput {
  id: string;
  feature: ManageableFeatureName;
  /** What the caller asked for. Never inferred from the current feature state. */
  operation: FeatureInstallOperation;
  requestedByUserId: number;
  requestedInChatId: number;
  workflowReceiptId: string;
  /** The exact state the confirmed button was rendered against. */
  expected: { installed: boolean; enabled: boolean };
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
    @Inject(FEATURE_RUNTIME_LIFECYCLE)
    private readonly lifecycle: Pick<FeatureRuntimeLifecycleRegistryPort, 'beforeDisable' | 'afterEnable'>,
    @Inject(FEATURE_CLOCK) private readonly clock: FeatureClockPort,
    private readonly recovery: FeatureInstallRecoveryService,
  ) {}

  async execute(input: BeginFeatureInstallInput): Promise<BeginFeatureInstallResult> {
    // `createQueued` is the state fence: it refuses when the feature no longer
    // matches the snapshot the confirmed button was rendered against.
    const job = await this.jobs.createQueued({ ...input, now: this.clock.now() });
    const request = { version: 1 as const, jobId: job.id, feature: job.feature };
    if (!await this.quiesceRuntime(job)) throw new FeatureInstallStartError(job.feature);

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

  /**
   * A reinstall re-runs the privileged routine underneath a feature that is
   * already serving traffic, so its runtime stops before the request becomes
   * visible to the helper. Nothing is deleted: only in-flight work is stood
   * down and the start gate is closed.
   */
  private async quiesceRuntime(job: FeatureInstallJob): Promise<boolean> {
    if (job.operation !== 'reinstall') return true;
    try {
      await this.lifecycle.beforeDisable(job.feature);
      return true;
    } catch {
      // Nothing was published, so the previous installation is provably whole.
      await this.terminalizeUnpublished(job);
      return false;
    }
  }

  private async terminalizeUnpublished(job: FeatureInstallJob): Promise<void> {
    try {
      await this.jobs.terminalizeFailure({
        id: job.id,
        failureCode: 'request-publish-failed',
        attentionReason: null,
        preservePreviousState: true,
        now: this.clock.now(),
      });
    } catch {
      this.recovery.wake();
      return;
    }
    await this.restoreRuntime(job);
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
        await this.restoreRuntime(job);
        return;
      }
    } catch {
      // An unverified cancellation cannot safely clear the active job, and an
      // unclaimed request may still run: the gate stays closed.
    }
    this.recovery.wake();
  }

  /**
   * Reopening the gate is best effort by design. `afterEnable` re-checks the
   * feature itself, so a still-broken RTSP feature keeps its closed gate rather
   * than being talked back open here.
   */
  private async restoreRuntime(job: FeatureInstallJob): Promise<void> {
    if (job.operation !== 'reinstall' || !job.previousEnabled) return;
    await this.lifecycle.afterEnable(job.feature).catch(() => undefined);
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { FeatureRestartDispatchError } from '../domain/errors/feature-restart-dispatch.error';
import type {
  FeatureInstallFailureCode,
  FeatureInstallJob,
  FeatureInstallResultV1,
  ManageableFeatureName,
  RestartScope,
} from '../domain/manageable-feature';
import {
  FEATURE_CLOCK,
  type FeatureClockPort,
} from '../domain/ports/feature-clock.port';
import {
  FEATURE_INSTALL_JOB_REPOSITORY,
  type FeatureInstallJobRepositoryPort,
} from '../domain/ports/feature-install-job.repository.port';
import {
  FEATURE_INSTALL_OUTCOME_REGISTRY,
  type FeatureInstallOutcomeRegistryPort,
} from '../domain/ports/feature-install-outcome.port';
import {
  FEATURE_INSTALL_RESULT,
  type FeatureInstallResultPort,
} from '../domain/ports/feature-install-result.port';
import {
  FEATURE_PROCESS_IDENTITY,
  type FeatureProcessIdentityPort,
} from '../domain/ports/feature-process-identity.port';
import {
  FEATURE_REPOSITORY,
  type FeatureRepositoryPort,
} from '../domain/ports/feature-repository.port';
import {
  FEATURE_RESTART,
  type FeatureRestartPort,
} from '../domain/ports/feature-restart.port';
import {
  FEATURE_RUNTIME_LIFECYCLE,
  type FeatureRuntimeLifecycleRegistryPort,
} from '../domain/ports/feature-runtime-lifecycle.port';
import { VerifyFeatureReadinessUseCase } from './verify-feature-readiness.use-case';

export const FEATURE_INSTALL_RESTART_SCOPE: Readonly<Record<ManageableFeatureName, RestartScope>> = {
  digital: 'worker',
  uart: 'host',
  zigbee: 'worker',
  motion: 'supervisor',
  rtsp: 'supervisor',
};

const SAFE_FAILURES = new Set<FeatureInstallFailureCode>([
  'request-invalid',
  'request-publish-failed',
  'helper-version-mismatch',
]);

/** Reconciles one durable helper result. Concurrent calls for a job coalesce. */
@Injectable()
export class ReconcileFeatureInstallUseCase {
  private readonly logger = new Logger(ReconcileFeatureInstallUseCase.name);
  private readonly inFlight = new Map<string, Promise<FeatureInstallJob | null>>();

  constructor(
    @Inject(FEATURE_INSTALL_JOB_REPOSITORY)
    private readonly jobs: FeatureInstallJobRepositoryPort,
    @Inject(FEATURE_INSTALL_RESULT)
    private readonly results: FeatureInstallResultPort,
    private readonly verify: VerifyFeatureReadinessUseCase,
    @Inject(FEATURE_RUNTIME_LIFECYCLE)
    private readonly lifecycle: FeatureRuntimeLifecycleRegistryPort,
    @Inject(FEATURE_RESTART) private readonly restart: FeatureRestartPort,
    @Inject(FEATURE_REPOSITORY) private readonly features: FeatureRepositoryPort,
    @Inject(FEATURE_INSTALL_OUTCOME_REGISTRY)
    private readonly outcomes: FeatureInstallOutcomeRegistryPort,
    @Inject(FEATURE_CLOCK) private readonly clock: FeatureClockPort,
    @Inject(FEATURE_PROCESS_IDENTITY)
    private readonly identity: FeatureProcessIdentityPort,
  ) {}

  execute(id: string): Promise<FeatureInstallJob | null> {
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    const operation = this.reconcile(id).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, operation);
    return operation;
  }

  private async reconcile(id: string): Promise<FeatureInstallJob | null> {
    const job = await this.jobs.findById(id);
    if (!job) return null;
    if (job.status === 'succeeded' || job.status === 'failed') {
      return job;
    }
    // The privileged work is already durable and its phase is persisted, so the
    // helper is never consulted — nor started — for an awaiting-restart job.
    if (job.status === 'awaiting-restart') return this.reconcileAwaitingRestart(job);

    let state: Awaited<ReturnType<FeatureInstallResultPort['readState']>>;
    try {
      state = await this.results.readState(job.id, job.feature);
    } catch {
      return this.reconcileFailure(job, 'result-invalid');
    }
    if (state.kind === 'absent') return null;
    if (state.kind === 'running') {
      if (job.status === 'queued') return this.jobs.markRunning(job.id, this.clock.now());
      return job;
    }
    // A helper that finished before this process saw its marker still has to
    // pass through `running`: that is the only phase a durable result reconciles from.
    const claimed = job.status === 'queued'
      ? await this.jobs.markRunning(job.id, this.clock.now())
      : job;
    if (!sameIdentity(claimed, state.result)) return this.reconcileFailure(claimed, 'result-invalid');
    if (state.result.outcome === 'failed') return this.reconcileFailure(claimed, state.result.failureCode);
    return this.reconcileSuccess(claimed, state.result);
  }

  private async reconcileSuccess(
    job: FeatureInstallJob,
    result: FeatureInstallResultV1,
  ): Promise<FeatureInstallJob> {
    // The helper's scope is informative only. Recovery has a compiled fixed
    // scope even if a compatible helper omitted it.
    return this.awaitRestart(job, result.restartScope ?? FEATURE_INSTALL_RESTART_SCOPE[job.feature]);
  }

  /**
   * Privileged success is durable but unproven: this process cannot pick up a
   * group it was just granted, so the job parks with the identity that is about
   * to dispatch the restart. Nothing is installed, enabled, or announced here.
   */
  private async awaitRestart(
    job: FeatureInstallJob,
    scope: RestartScope,
  ): Promise<FeatureInstallJob> {
    const identity = await this.currentIdentity();
    if (identity === null) return job;
    const awaiting = await this.jobs.markAwaitingRestart({
      id: job.id,
      restartScope: scope,
      dispatchIdentity: identity,
      now: this.clock.now(),
    });
    await this.outcomes.notifyPreRestart(awaiting);
    return this.dispatchRestart(awaiting, scope);
  }

  /**
   * One dispatch per process identity, forever: the recorded identity is the
   * fence that keeps a two-second recovery pass from restarting the supervisor
   * on every tick. Only a genuinely restarted process may verify the install.
   */
  private async reconcileAwaitingRestart(job: FeatureInstallJob): Promise<FeatureInstallJob> {
    const scope = job.restartScope ?? FEATURE_INSTALL_RESTART_SCOPE[job.feature];
    const identity = await this.currentIdentity();
    if (identity === null || identity === job.restartDispatchIdentity) return job;

    const readiness = await this.postInstallReadiness(job.feature);
    if (readiness.ready) return this.terminalSuccess(job, scope);
    if (readiness.reason === 'runtime-group-incomplete') {
      // The restart happened but the runtime group did not arrive with it.
      const retried = await this.jobs.recordRestartDispatch({
        id: job.id,
        dispatchIdentity: identity,
        now: this.clock.now(),
      });
      this.logger.warn(`Feature '${job.feature}' still lacks its runtime group; dispatching ${scope} restart again`);
      return this.dispatchRestart(retried, scope);
    }
    return this.terminalFailure(job, 'application-verification-failed', 'readiness-failed', true);
  }

  private async terminalSuccess(
    job: FeatureInstallJob,
    scope: RestartScope,
  ): Promise<FeatureInstallJob> {
    const terminal = await this.jobs.terminalizeSuccess({
      id: job.id,
      restartScope: scope,
      now: this.clock.now(),
    });
    await this.removeResultBestEffort(job.id);
    try {
      await this.lifecycle.afterEnable(job.feature);
    } catch {
      await this.features.setAttention(job.feature, 'partial-state-uncertain').catch(() => undefined);
    }
    await this.outcomes.notify(terminal);
    return terminal;
  }

  private async dispatchRestart(
    job: FeatureInstallJob,
    scope: RestartScope,
  ): Promise<FeatureInstallJob> {
    try {
      await this.restart.dispatch(scope);
    } catch {
      // The job keeps the active slot: a later process reconciles the same
      // durable phase once an administrator dispatches the fixed unit.
      await this.features.setAttention(job.feature, 'restart-required').catch(() => undefined);
      throw new FeatureRestartDispatchError(job.feature, scope);
    }
    return job;
  }

  /** A procfs read failure is transient: recovery retries rather than guessing. */
  private async currentIdentity(): Promise<string | null> {
    try {
      return await this.identity.current();
    } catch {
      return null;
    }
  }

  private async reconcileFailure(
    job: FeatureInstallJob,
    code: FeatureInstallFailureCode,
  ): Promise<FeatureInstallJob> {
    if (SAFE_FAILURES.has(code)) return this.terminalFailure(job, code, null, true);

    const readiness = await this.postInstallReadiness(job.feature);
    if (readiness.ready && !job.previousInstalled) {
      // The helper reported a cause this process cannot see: the dependencies
      // are present. It is still an install, so it earns no shortcut past the
      // restart fence.
      return this.awaitRestart(job, FEATURE_INSTALL_RESTART_SCOPE[job.feature]);
    }
    if (readiness.ready && job.previousInstalled) {
      return this.terminalFailure(job, code, 'install-failed', true);
    }
    return this.terminalFailure(job, 'partial-state-uncertain', 'partial-state-uncertain', true);
  }

  private async postInstallReadiness(feature: ManageableFeatureName) {
    try {
      return await this.verify.execute({ name: feature, source: 'post-install' });
    } catch {
      return {
        ready: false as const,
        failureCode: 'application-verification-failed' as const,
        reason: 'runtime-invalid' as const,
      };
    }
  }

  private async terminalFailure(
    job: FeatureInstallJob,
    failureCode: FeatureInstallFailureCode,
    attentionReason: 'install-failed' | 'partial-state-uncertain' | 'readiness-failed' | null,
    preservePreviousState: boolean,
  ): Promise<FeatureInstallJob> {
    const terminal = await this.jobs.terminalizeFailure({
      id: job.id,
      failureCode,
      attentionReason,
      preservePreviousState,
      now: this.clock.now(),
    });
    await this.removeResultBestEffort(job.id);
    await this.outcomes.notify(terminal);
    return terminal;
  }

  private async removeResultBestEffort(id: string): Promise<void> {
    await this.results.removeTerminal(id).catch(() => undefined);
  }
}

function sameIdentity(job: FeatureInstallJob, result: FeatureInstallResultV1): boolean {
  return result.version === 1 && result.jobId === job.id && result.feature === job.feature;
}

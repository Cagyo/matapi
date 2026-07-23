import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { FeatureInstallJob } from '../domain/manageable-feature';
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
  FEATURE_INSTALL_OUTCOME_REGISTRY,
  type FeatureInstallOutcomeRegistryPort,
} from '../domain/ports/feature-install-outcome.port';
import {
  FEATURE_INSTALL_REQUEST,
  type FeatureInstallRequestPort,
} from '../domain/ports/feature-install-request.port';
import {
  FEATURE_INSTALL_RESULT,
  type FeatureInstallResultPort,
} from '../domain/ports/feature-install-result.port';
import { ReconcileFeatureInstallUseCase } from './reconcile-feature-install.use-case';

const POLL_MS = 2_000;
const RECOVERY_OBSERVATION_MS = 2_000;
const UNCLAIMED_REQUEST_TIMEOUT_MS = 35 * 60_000;

/**
 * Restarts the fixed helper and reconciles durable state. A timeout is allowed
 * to cancel only the still-unclaimed request; root-owned work is never guessed
 * terminal merely because this process has waited for it.
 */
@Injectable()
export class FeatureInstallRecoveryService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private currentPass: Promise<void> | undefined;
  private readonly absentSince = new Map<string, number>();
  private stopped = false;

  constructor(
    @Inject(FEATURE_INSTALL_JOB_REPOSITORY)
    private readonly jobs: FeatureInstallJobRepositoryPort,
    @Inject(FEATURE_INSTALL_REQUEST)
    private readonly requests: FeatureInstallRequestPort,
    @Inject(FEATURE_INSTALL_RESULT)
    private readonly results: FeatureInstallResultPort,
    @Inject(FEATURE_INSTALL_CONTROLLER)
    private readonly controller: FeatureInstallControllerPort,
    private readonly reconcile: ReconcileFeatureInstallUseCase,
    @Inject(FEATURE_INSTALL_OUTCOME_REGISTRY)
    private readonly outcomes: FeatureInstallOutcomeRegistryPort,
    @Inject(FEATURE_CLOCK) private readonly clock: FeatureClockPort,
  ) {}

  async onModuleInit(): Promise<void> {
    const terminal = await this.jobs.listRecentTerminal(25);
    for (const job of terminal) await this.outcomes.notify(job);
    this.wake();
  }

  wake(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runPass().catch(() => undefined);
    }, 0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.currentPass;
  }

  /** Exposed for deterministic use-case tests; normal execution uses wake(). */
  async runPass(): Promise<void> {
    if (this.currentPass) return this.currentPass;
    const pass = this.pass().finally(() => {
      if (this.currentPass === pass) this.currentPass = undefined;
    });
    this.currentPass = pass;
    return pass;
  }

  private async pass(): Promise<void> {
    const active = await this.jobs.findActive();
    if (!active || this.stopped) return;

    // The root helper may be resuming a durable claim, so every active pass
    // first gives it a chance to run before inspecting spool state.
    try {
      await this.controller.start();
    } catch {
      await this.scheduleNext();
      return;
    }

    let state: Awaited<ReturnType<FeatureInstallResultPort['readState']>>;
    try {
      state = await this.results.readState(active.id, active.feature);
    } catch {
      await this.reconcile.execute(active.id).catch(() => undefined);
      await this.scheduleNext();
      return;
    }

    if (state.kind === 'terminal') {
      this.absentSince.delete(active.id);
      await this.reconcile.execute(active.id).catch(() => undefined);
      await this.scheduleNext();
      return;
    }
    if (state.kind === 'running') {
      this.absentSince.delete(active.id);
      if (active.status === 'queued') await this.jobs.markRunning(active.id, this.clock.now()).catch(() => undefined);
      await this.scheduleNext();
      return;
    }

    await this.handleAbsent(active);
    await this.scheduleNext();
  }

  private async handleAbsent(job: FeatureInstallJob): Promise<void> {
    const now = this.clock.now().getTime();
    const firstAbsent = this.absentSince.get(job.id) ?? now;
    this.absentSince.set(job.id, firstAbsent);
    const request = { version: 1 as const, jobId: job.id, feature: job.feature };

    // Wait through a bounded observation window before republishing a queued
    // request. A claimed request has moved out of this directory and publish
    // remains idempotent for an unclaimed one.
    if (job.status === 'queued' && now - firstAbsent >= RECOVERY_OBSERVATION_MS) {
      await this.requests.publish(request).catch(() => undefined);
    }
    if (now - job.updatedAt.getTime() < UNCLAIMED_REQUEST_TIMEOUT_MS) return;

    // This is the sole timeout terminalization path. `false` means root owns
    // the request (or won a race), so retain the active job and keep waking.
    let cancelled = false;
    try {
      cancelled = await this.requests.cancelUnclaimed(request);
    } catch {
      return;
    }
    if (!cancelled) return;
    this.absentSince.delete(job.id);
    const terminal = await this.jobs.terminalizeFailure({
      id: job.id,
      failureCode: 'interrupted',
      attentionReason: 'partial-state-uncertain',
      preservePreviousState: true,
      now: this.clock.now(),
    });
    await this.outcomes.notify(terminal);
  }

  private async scheduleNext(): Promise<void> {
    if (this.stopped || this.timer) return;
    if (!await this.jobs.findActive()) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runPass().catch(() => undefined);
    }, POLL_MS);
  }
}

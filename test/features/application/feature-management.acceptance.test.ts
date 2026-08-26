import { describe, expect, it } from 'vitest';
import { BeginFeatureInstallUseCase } from '../../../src/features/application/begin-feature-install.use-case';
import { DisableFeatureUseCase } from '../../../src/features/application/disable-feature.use-case';
import { EnableFeatureUseCase } from '../../../src/features/application/enable-feature.use-case';
import { FeatureAvailabilityService } from '../../../src/features/application/feature-availability.service';
import { FeatureDisableLifecycleRegistry } from '../../../src/features/application/feature-disable-lifecycle-registry.service';
import { FeatureInstallOutcomeRegistryService } from '../../../src/features/application/feature-install-outcome-registry.service';
import type { FeatureInstallRecoveryService } from '../../../src/features/application/feature-install-recovery.service';
import { GetFeatureDetailUseCase } from '../../../src/features/application/get-feature-detail.use-case';
import { ListManageableFeaturesUseCase } from '../../../src/features/application/list-manageable-features.use-case';
import { ReconcileFeatureInstallUseCase } from '../../../src/features/application/reconcile-feature-install.use-case';
import { VerifyFeatureReadinessUseCase } from '../../../src/features/application/verify-feature-readiness.use-case';
import { FeatureInstallBusyError } from '../../../src/features/domain/errors/feature-install-busy.error';
import { FeatureRestartDispatchError } from '../../../src/features/domain/errors/feature-restart-dispatch.error';
import {
  MANAGEABLE_FEATURE_NAMES,
  type FeatureInstallJob,
  type FeatureInstallRequestV1,
  type FeatureInstallResultV1,
  type ManageableFeatureName,
  type RestartScope,
} from '../../../src/features/domain/manageable-feature';
import type { FeatureClockPort } from '../../../src/features/domain/ports/feature-clock.port';
import type { FeatureInstallControllerPort } from '../../../src/features/domain/ports/feature-install-controller.port';
import type { FeatureInstallOutcomePort } from '../../../src/features/domain/ports/feature-install-outcome.port';
import type { FeatureInstallRequestPort } from '../../../src/features/domain/ports/feature-install-request.port';
import type { FeatureInstallResultPort } from '../../../src/features/domain/ports/feature-install-result.port';
import type { FeatureProcessIdentityPort } from '../../../src/features/domain/ports/feature-process-identity.port';
import type { FeatureReadinessBarrierPort } from '../../../src/features/domain/ports/feature-readiness-barrier.port';
import type { FeatureRestartPort } from '../../../src/features/domain/ports/feature-restart.port';
import type { FeatureRuntimeLifecyclePort } from '../../../src/features/domain/ports/feature-runtime-lifecycle.port';
import { InMemoryFeatureInstallJobRepository } from '../../../src/features/infrastructure/in-memory-feature-install-job.repository';
import { InMemoryFeatureReadinessAdapter } from '../../../src/features/infrastructure/in-memory-feature-readiness.adapter';
import { InMemoryFeatureRepository } from '../../../src/features/infrastructure/in-memory-feature.repository';

const now = new Date('2030-01-01T00:00:00.000Z');

class FixedClock implements FeatureClockPort {
  now(): Date {
    return now;
  }
}

class ResolvedReadinessBarrier implements FeatureReadinessBarrierPort {
  async awaitInitialVerification(): Promise<void> {
    return undefined;
  }
}

class InMemoryInstallRequestAdapter implements FeatureInstallRequestPort {
  readonly published: FeatureInstallRequestV1[] = [];

  async publish(request: FeatureInstallRequestV1): Promise<'published'> {
    this.published.push(request);
    return 'published';
  }

  async cancelUnclaimed(_request: FeatureInstallRequestV1): Promise<boolean> {
    return true;
  }
}

class InMemoryInstallResultAdapter implements FeatureInstallResultPort {
  private readonly terminal = new Map<string, FeatureInstallResultV1>();

  setTerminal(result: FeatureInstallResultV1): void {
    this.terminal.set(result.jobId, result);
  }

  async readState(jobId: string, _feature: ManageableFeatureName): Promise<
    | { kind: 'absent' }
    | { kind: 'running' }
    | { kind: 'terminal'; result: FeatureInstallResultV1 }
  > {
    const result = this.terminal.get(jobId);
    return result ? { kind: 'terminal', result } : { kind: 'absent' };
  }

  async removeTerminal(jobId: string): Promise<void> {
    this.terminal.delete(jobId);
  }
}

/** A restart of the worker is the only thing that changes this value. */
class RestartableProcessIdentity implements FeatureProcessIdentityPort {
  private starts = 1;

  restart(): void {
    this.starts += 1;
  }

  async current(): Promise<string> {
    return `4f8b2c1d-0e6a-47b3-8d59-2c7e1a0f4b63:${this.starts}00`;
  }
}

class RecordingInstallController implements FeatureInstallControllerPort {
  starts = 0;

  async start(): Promise<void> {
    this.starts += 1;
  }
}

class RecordingRestartAdapter implements FeatureRestartPort {
  readonly scopes: RestartScope[] = [];
  failNext = false;

  async dispatch(scope: RestartScope): Promise<void> {
    this.scopes.push(scope);
    if (!this.failNext) return;
    this.failNext = false;
    throw new Error('restart unavailable');
  }
}

class RecordingLifecycle implements FeatureRuntimeLifecyclePort {
  beforeDisableCalls = 0;
  afterEnableCalls = 0;

  async beforeDisable(): Promise<void> {
    this.beforeDisableCalls += 1;
  }

  async afterEnable(): Promise<void> {
    this.afterEnableCalls += 1;
  }
}

class FailingWorkflowDelivery implements FeatureInstallOutcomePort {
  terminalAttempts = 0;
  preRestartAttempts = 0;

  async notifyPreRestart(_job: FeatureInstallJob): Promise<void> {
    this.preRestartAttempts += 1;
    throw new Error('Telegram unavailable');
  }

  async notify(_job: FeatureInstallJob): Promise<void> {
    this.terminalAttempts += 1;
    throw new Error('Telegram unavailable');
  }
}

class RecoveryWakeSpy {
  wakes = 0;

  wake(): void {
    this.wakes += 1;
  }
}

function expected(feature: { installed: boolean; enabled: boolean; attentionReason: null }) {
  return {
    installed: feature.installed,
    enabled: feature.enabled,
    attentionReason: feature.attentionReason,
  };
}

describe('feature management acceptance', () => {
  it('keeps terminal install state independent from restart and workflow delivery failures', async () => {
    const features = new InMemoryFeatureRepository(
      MANAGEABLE_FEATURE_NAMES.map((name) => ({
        name,
        installed: false,
        enabled: false,
        config: null,
        attentionReason: null,
      })),
    );
    const jobs = new InMemoryFeatureInstallJobRepository(features);
    const readiness = new InMemoryFeatureReadinessAdapter();
    const requests = new InMemoryInstallRequestAdapter();
    const results = new InMemoryInstallResultAdapter();
    const controller = new RecordingInstallController();
    const lifecycle = new FeatureDisableLifecycleRegistry();
    const motionRuntime = new RecordingLifecycle();
    lifecycle.register('motion', motionRuntime);
    const restart = new RecordingRestartAdapter();
    const outcomes = new FeatureInstallOutcomeRegistryService();
    const delivery = new FailingWorkflowDelivery();
    outcomes.register(delivery);
    const clock = new FixedClock();
    const identity = new RestartableProcessIdentity();
    const verify = new VerifyFeatureReadinessUseCase(features, readiness);
    const availability = new FeatureAvailabilityService(
      features,
      jobs,
      new ResolvedReadinessBarrier(),
    );
    const list = new ListManageableFeaturesUseCase(availability);
    const detail = new GetFeatureDetailUseCase(availability);
    const recovery = new RecoveryWakeSpy();
    const install = new BeginFeatureInstallUseCase(
      jobs,
      requests,
      controller,
      lifecycle,
      clock,
      recovery as unknown as FeatureInstallRecoveryService,
    );
    const reconcile = new ReconcileFeatureInstallUseCase(
      jobs,
      results,
      verify,
      lifecycle,
      restart,
      features,
      outcomes,
      clock,
      identity,
    );
    const disable = new DisableFeatureUseCase(features, jobs, lifecycle, restart);
    const enable = new EnableFeatureUseCase(features, jobs, verify, lifecycle, restart);

    expect((await list.execute()).map((feature) => feature.name)).toEqual(MANAGEABLE_FEATURE_NAMES);
    expect((await detail.execute('motion')).status.action).toBe('install');

    const jobId = 'abcdefghijklmnop';
    await install.execute({
      id: jobId,
      feature: 'motion',
      operation: 'install',
      requestedByUserId: 7,
      requestedInChatId: 11,
      workflowReceiptId: 'ponmlkjihgfedcba',
      expected: { installed: false, enabled: false },
    });

    expect(await jobs.findActive()).toMatchObject({ id: jobId, feature: 'motion', activeSlot: 1 });
    await expect(install.execute({
      id: 'qrstuvwxyzABCDEF',
      feature: 'digital',
      operation: 'install',
      requestedByUserId: 7,
      requestedInChatId: 11,
      workflowReceiptId: 'fedcbazyxwvutsrq',
      expected: { installed: false, enabled: false },
    })).rejects.toBeInstanceOf(FeatureInstallBusyError);
    expect(await jobs.findActive()).toMatchObject({ id: jobId, activeSlot: 1 });

    results.setTerminal({
      version: 1,
      jobId,
      feature: 'motion',
      outcome: 'succeeded',
      failureCode: null,
      privilegedReady: true,
      restartScope: 'supervisor',
    });
    restart.failNext = true;

    // Privileged success is durable but unproven: the job parks, nothing is
    // installed or announced, and the failed dispatch stays recoverable.
    await expect(reconcile.execute(jobId)).rejects.toBeInstanceOf(FeatureRestartDispatchError);
    expect(await jobs.findById(jobId)).toMatchObject({ status: 'awaiting-restart', activeSlot: 1 });
    expect(await jobs.findActive()).toMatchObject({ id: jobId, activeSlot: 1 });
    expect(await features.findByName('motion')).toMatchObject({
      installed: false,
      enabled: false,
      attentionReason: 'restart-required',
    });
    expect(delivery).toMatchObject({ preRestartAttempts: 1, terminalAttempts: 0 });
    expect(motionRuntime.afterEnableCalls).toBe(0);

    // The same process may not complete it, however often recovery ticks.
    await reconcile.execute(jobId);
    expect(await jobs.findById(jobId)).toMatchObject({ status: 'awaiting-restart', activeSlot: 1 });
    expect(restart.scopes).toEqual(['supervisor']);

    identity.restart();
    await reconcile.execute(jobId);
    expect(await jobs.findById(jobId)).toMatchObject({ status: 'succeeded', activeSlot: null });
    expect(await jobs.findActive()).toBeNull();
    expect(await features.findByName('motion')).toMatchObject({
      installed: true,
      enabled: true,
      attentionReason: null,
    });
    expect(delivery).toMatchObject({ preRestartAttempts: 1, terminalAttempts: 1 });

    await expect(verify.execute({ name: 'motion', source: 'manual' })).resolves.toMatchObject({ ready: true });
    const readyMotion = await features.findByName('motion');
    expect(readyMotion).toMatchObject({ installed: true, enabled: true, attentionReason: null });
    if (!readyMotion) throw new Error('Motion feature is missing');

    await disable.execute({ name: 'motion', expected: expected(readyMotion) });
    expect(await features.findByName('motion')).toMatchObject({
      installed: true,
      enabled: false,
      attentionReason: null,
    });
    expect(motionRuntime.beforeDisableCalls).toBe(1);

    const disabledMotion = await features.findByName('motion');
    expect(disabledMotion).toMatchObject({ installed: true, enabled: false, attentionReason: null });
    if (!disabledMotion) throw new Error('Motion feature is missing');

    await enable.execute({ name: 'motion', expected: expected(disabledMotion) });
    expect(await features.findByName('motion')).toMatchObject({
      installed: true,
      enabled: true,
      attentionReason: null,
    });
    expect(motionRuntime.afterEnableCalls).toBe(2);
    expect(requests.published).toHaveLength(1);
    expect(controller.starts).toBe(1);
    expect(recovery.wakes).toBe(1);
  });
});

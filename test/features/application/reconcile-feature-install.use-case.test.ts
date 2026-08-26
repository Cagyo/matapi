import { describe, expect, it, vi } from 'vitest';
import { ReconcileFeatureInstallUseCase } from '../../../src/features/application/reconcile-feature-install.use-case';
import { VerifyFeatureReadinessUseCase } from '../../../src/features/application/verify-feature-readiness.use-case';
import { FeatureRestartDispatchError } from '../../../src/features/domain/errors/feature-restart-dispatch.error';
import type {
  FeatureAttentionReason,
  FeatureInstallFailureCode,
  FeatureInstallJobStatus,
  FeatureInstallOperation,
  FeatureInstallResultV1,
  ManageableFeatureName,
} from '../../../src/features/domain/manageable-feature';
import type { FeatureInstallResultPort } from '../../../src/features/domain/ports/feature-install-result.port';
import type { FeatureProcessIdentityPort } from '../../../src/features/domain/ports/feature-process-identity.port';
import type {
  FeatureReadinessPort,
  FeatureReadinessResult,
} from '../../../src/features/domain/ports/feature-readiness.port';
import { InMemoryFeatureInstallJobRepository } from '../../../src/features/infrastructure/in-memory-feature-install-job.repository';
import { InMemoryFeatureRepository } from '../../../src/features/infrastructure/in-memory-feature.repository';

const now = new Date('2030-01-01T00:00:00.000Z');
const id = 'abcdefghijklmnop';
const boot = '6f1d9c0e-0a5b-4c7d-9f2e-1a3b5c7d9e0f';
/** A new identity means the worker really re-executed; the boot half is shared. */
const first = `${boot}:100`;
const second = `${boot}:200`;
const third = `${boot}:300`;

const READY: FeatureReadinessResult = { ready: true, restartScope: 'worker' };
const GROUP_INCOMPLETE: FeatureReadinessResult = {
  ready: false, failureCode: 'application-verification-failed', reason: 'runtime-group-incomplete',
};
const POLICY_STALE: FeatureReadinessResult = {
  ready: false, failureCode: 'application-verification-failed', reason: 'policy-stale',
};
const RUNTIME_INVALID: FeatureReadinessResult = {
  ready: false, failureCode: 'application-verification-failed', reason: 'runtime-invalid',
};

type ResultState = Awaited<ReturnType<FeatureInstallResultPort['readState']>>;
type ReadinessStep = FeatureReadinessResult | 'throws';

const succeeded: FeatureInstallResultV1 = {
  version: 1, jobId: id, feature: 'digital', outcome: 'succeeded',
  failureCode: null, privilegedReady: true, restartScope: 'worker',
};

function failed(failureCode: FeatureInstallFailureCode): FeatureInstallResultV1 {
  return { version: 1, jobId: id, feature: 'digital', outcome: 'failed', failureCode, privilegedReady: false, restartScope: null };
}

/** Answers readiness step by step, repeating the last answer, and counts probes. */
class ScriptedReadiness implements FeatureReadinessPort {
  calls = 0;

  constructor(private readonly steps: readonly ReadinessStep[]) {}

  async verify(_name: ManageableFeatureName): Promise<FeatureReadinessResult> {
    const step = this.steps[Math.min(this.calls, this.steps.length - 1)] ?? READY;
    this.calls += 1;
    if (step === 'throws') throw new Error('readiness probe failed');
    return step;
  }
}

/** The identity this process reports; the test moves it to simulate a restart. */
class StubProcessIdentity implements FeatureProcessIdentityPort {
  value: string | null = first;

  async current(): Promise<string> {
    if (this.value === null) throw new Error('procfs is unreadable');
    return this.value;
  }
}

interface Summary {
  status: FeatureInstallJobStatus;
  activeSlot: 1 | null;
  failureCode: FeatureInstallFailureCode | null;
  dispatchIdentity: string | null;
  installed: boolean;
  enabled: boolean;
  attentionReason: FeatureAttentionReason | null;
  dispatches: number;
  restartErrors: number;
  readinessProbes: number;
  afterEnable: number;
  preRestart: number;
  notified: number;
  resultRemoved: number;
}

interface Scenario {
  name: string;
  /** Feature state before the job; `true` starts installed and enabled. */
  installed?: boolean;
  /** Overrides the enabled half of that state when they must differ. */
  enabled?: boolean;
  /** What the administrator asked for; never inferred from `installed`. */
  operation?: FeatureInstallOperation;
  given?: 'queued' | 'running' | 'awaiting-restart';
  state?: ResultState;
  readiness?: readonly ReadinessStep[];
  /** One reconcile tick per entry; `null` makes the identity unreadable. */
  identities: readonly (string | null)[];
  failDispatch?: 'first' | 'always';
  failAfterEnable?: boolean;
  expected: Summary;
}

function create(scenario: Scenario) {
  const installed = scenario.installed ?? false;
  const features = new InMemoryFeatureRepository([
    { name: 'digital', installed, enabled: enabledOf(scenario), config: null, attentionReason: null },
  ]);
  const jobs = new InMemoryFeatureInstallJobRepository(features);
  const readiness = new ScriptedReadiness(scenario.readiness ?? [READY]);
  const identity = new StubProcessIdentity();
  const state: ResultState = scenario.state ?? { kind: 'terminal', result: succeeded };
  const results = {
    readState: vi.fn(async (): Promise<ResultState> => state),
    removeTerminal: vi.fn(async () => undefined),
  };
  const lifecycle = {
    register: vi.fn(),
    beforeDisable: vi.fn(async () => undefined),
    afterEnable: vi.fn(async () => {
      if (scenario.failAfterEnable) throw new Error('start gate unavailable');
    }),
  };
  let dispatches = 0;
  const restart = {
    dispatch: vi.fn(async () => {
      dispatches += 1;
      if (scenario.failDispatch === 'always' || (scenario.failDispatch === 'first' && dispatches === 1)) {
        throw new Error('supervisor unavailable');
      }
    }),
  };
  const outcomes = {
    register: vi.fn(),
    notifyPreRestart: vi.fn(async () => undefined),
    notify: vi.fn(async () => undefined),
  };
  const useCase = new ReconcileFeatureInstallUseCase(
    jobs, results, new VerifyFeatureReadinessUseCase(features, readiness),
    lifecycle, restart, features, outcomes, { now: () => now }, identity,
  );
  return { features, jobs, readiness, identity, results, lifecycle, restart, outcomes, useCase };
}

type Harness = ReturnType<typeof create>;

function enabledOf(scenario: Scenario): boolean {
  return scenario.enabled ?? scenario.installed ?? false;
}

async function arrange(test: Harness, scenario: Scenario): Promise<void> {
  const installed = scenario.installed ?? false;
  await test.jobs.createQueued({
    id, feature: 'digital', operation: scenario.operation ?? 'install',
    requestedByUserId: 1, requestedInChatId: 2,
    workflowReceiptId: 'ponmlkjihgfedcba',
    expected: { installed, enabled: enabledOf(scenario) }, now,
  });
  const given = scenario.given ?? 'running';
  if (given === 'queued') return;
  await test.jobs.markRunning(id, now);
  if (given !== 'awaiting-restart') return;
  // A crash between persisting the phase and dispatching leaves exactly this.
  await test.jobs.markAwaitingRestart({ id, restartScope: 'worker', dispatchIdentity: first, now });
}

async function summarize(test: Harness, restartErrors: number): Promise<Summary> {
  const job = await test.jobs.findById(id);
  const feature = await test.features.findByName('digital');
  if (!job || !feature) throw new Error('Install job or feature is missing');
  return {
    status: job.status,
    activeSlot: job.activeSlot,
    failureCode: job.failureCode,
    dispatchIdentity: job.restartDispatchIdentity,
    installed: feature.installed,
    enabled: feature.enabled,
    attentionReason: feature.attentionReason,
    dispatches: test.restart.dispatch.mock.calls.length,
    restartErrors,
    readinessProbes: test.readiness.calls,
    afterEnable: test.lifecycle.afterEnable.mock.calls.length,
    preRestart: test.outcomes.notifyPreRestart.mock.calls.length,
    notified: test.outcomes.notify.mock.calls.length,
    resultRemoved: test.results.removeTerminal.mock.calls.length,
  };
}

async function run(scenario: Scenario): Promise<Summary> {
  const test = create(scenario);
  await arrange(test, scenario);
  let restartErrors = 0;
  for (const identity of scenario.identities) {
    test.identity.value = identity;
    try {
      await test.useCase.execute(id);
    } catch (error) {
      if (!(error instanceof FeatureRestartDispatchError)) throw error;
      restartErrors += 1;
    }
  }
  return summarize(test, restartErrors);
}

function summary(overrides: Partial<Summary> = {}): Summary {
  return {
    status: 'awaiting-restart', activeSlot: 1, failureCode: null, dispatchIdentity: first,
    installed: false, enabled: false, attentionReason: null,
    dispatches: 0, restartErrors: 0, readinessProbes: 0,
    afterEnable: 0, preRestart: 0, notified: 0, resultRemoved: 0,
    ...overrides,
  };
}

const scenarios: readonly Scenario[] = [
  {
    name: 'parks a privileged success and dispatches one restart without announcing it',
    identities: [first],
    expected: summary({ dispatches: 1, preRestart: 1 }),
  },
  {
    name: 'neither verifies nor dispatches again while the dispatching process still runs',
    identities: [first, first, first],
    expected: summary({ dispatches: 1, preRestart: 1 }),
  },
  {
    name: 'verifies a crash before dispatch from durable state alone',
    given: 'awaiting-restart',
    state: { kind: 'absent' },
    identities: [second],
    expected: summary({
      status: 'succeeded', activeSlot: null, installed: true, enabled: true,
      readinessProbes: 1, afterEnable: 1, notified: 1, resultRemoved: 1,
    }),
  },
  {
    name: 'verifies a crash after dispatch on the restarted process',
    identities: [first, second],
    expected: summary({
      status: 'succeeded', activeSlot: null, installed: true, enabled: true,
      dispatches: 1, readinessProbes: 1, afterEnable: 1, preRestart: 1, notified: 1, resultRemoved: 1,
    }),
  },
  {
    name: 'records the new identity and dispatches once when the runtime group is still missing',
    readiness: [GROUP_INCOMPLETE],
    identities: [first, second, second],
    expected: summary({ dispatchIdentity: second, dispatches: 2, readinessProbes: 1, preRestart: 1 }),
  },
  {
    name: 'dispatches once per process across two changes without the runtime group',
    readiness: [GROUP_INCOMPLETE],
    identities: [first, second, third],
    expected: summary({ dispatchIdentity: third, dispatches: 3, readinessProbes: 2, preRestart: 1 }),
  },
  {
    name: 'fails terminally when the restarted process finds a stale policy',
    readiness: [POLICY_STALE],
    identities: [first, second],
    expected: summary({
      status: 'failed', activeSlot: null, failureCode: 'application-verification-failed',
      attentionReason: 'readiness-failed', dispatches: 1, readinessProbes: 1,
      preRestart: 1, notified: 1, resultRemoved: 1,
    }),
  },
  {
    name: 'fails terminally when the restarted process finds an invalid runtime',
    readiness: [RUNTIME_INVALID],
    identities: [first, second],
    expected: summary({
      status: 'failed', activeSlot: null, failureCode: 'application-verification-failed',
      attentionReason: 'readiness-failed', dispatches: 1, readinessProbes: 1,
      preRestart: 1, notified: 1, resultRemoved: 1,
    }),
  },
  {
    name: 'treats a readiness probe that throws as an invalid runtime',
    readiness: ['throws'],
    identities: [first, second],
    expected: summary({
      status: 'failed', activeSlot: null, failureCode: 'application-verification-failed',
      attentionReason: 'readiness-failed', dispatches: 1, readinessProbes: 1,
      preRestart: 1, notified: 1, resultRemoved: 1,
    }),
  },
  {
    name: 'keeps a job whose restart dispatch failed recoverable and asks for a restart',
    failDispatch: 'always',
    identities: [first],
    expected: summary({
      attentionReason: 'restart-required', dispatches: 1, restartErrors: 1, preRestart: 1,
    }),
  },
  {
    name: 'lets a later process complete an install whose restart dispatch failed',
    failDispatch: 'first',
    identities: [first, second],
    expected: summary({
      status: 'succeeded', activeSlot: null, installed: true, enabled: true,
      dispatches: 1, restartErrors: 1, readinessProbes: 1, afterEnable: 1,
      preRestart: 1, notified: 1, resultRemoved: 1,
    }),
  },
  {
    name: 'records uncertainty when the start gate fails after fresh verification',
    failAfterEnable: true,
    identities: [first, second],
    expected: summary({
      status: 'succeeded', activeSlot: null, installed: true, enabled: true,
      attentionReason: 'partial-state-uncertain', dispatches: 1, readinessProbes: 1,
      afterEnable: 1, preRestart: 1, notified: 1, resultRemoved: 1,
    }),
  },
  {
    name: 'parks a helper failure whose readiness passes instead of announcing a fresh install',
    state: { kind: 'terminal', result: failed('dependency-install-failed') },
    identities: [first],
    expected: summary({ dispatches: 1, readinessProbes: 1, preRestart: 1 }),
  },
  {
    name: 'reports an install failure when a previously installed feature stays ready',
    installed: true,
    state: { kind: 'terminal', result: failed('dependency-install-failed') },
    identities: [first],
    expected: summary({
      status: 'failed', activeSlot: null, failureCode: 'dependency-install-failed',
      dispatchIdentity: null, installed: true, enabled: true, attentionReason: 'install-failed',
      readinessProbes: 1, notified: 1, resultRemoved: 1,
    }),
  },
  {
    name: 'records uncertainty for a helper failure that readiness cannot disprove',
    state: { kind: 'terminal', result: failed('dependency-install-failed') },
    readiness: [RUNTIME_INVALID],
    identities: [first],
    expected: summary({
      status: 'failed', activeSlot: null, failureCode: 'partial-state-uncertain',
      dispatchIdentity: null, attentionReason: 'partial-state-uncertain',
      readinessProbes: 1, notified: 1, resultRemoved: 1,
    }),
  },
  {
    name: 'terminalizes a safe helper failure without probing readiness',
    state: { kind: 'terminal', result: failed('request-publish-failed') },
    identities: [first],
    expected: summary({
      status: 'failed', activeSlot: null, failureCode: 'request-publish-failed',
      dispatchIdentity: null, notified: 1, resultRemoved: 1,
    }),
  },
  {
    name: 'restores a reinstall that failed before any policy rename once the old policy still verifies',
    operation: 'reinstall',
    installed: true,
    state: { kind: 'terminal', result: failed('local-network-unavailable') },
    identities: [first],
    expected: summary({
      status: 'failed', activeSlot: null, failureCode: 'local-network-unavailable',
      dispatchIdentity: null, installed: true, enabled: true, attentionReason: null,
      readinessProbes: 1, afterEnable: 1, notified: 1, resultRemoved: 1,
    }),
  },
  {
    name: 'restores a reinstall whose policy could not be generated',
    operation: 'reinstall',
    installed: true,
    state: { kind: 'terminal', result: failed('network-policy-generation-failed') },
    identities: [first],
    expected: summary({
      status: 'failed', activeSlot: null, failureCode: 'network-policy-generation-failed',
      dispatchIdentity: null, installed: true, enabled: true, attentionReason: null,
      readinessProbes: 1, afterEnable: 1, notified: 1, resultRemoved: 1,
    }),
  },
  {
    name: 'restores a reinstall whose dependencies failed before the first rename',
    operation: 'reinstall',
    installed: true,
    state: { kind: 'terminal', result: failed('dependency-install-failed') },
    identities: [first],
    expected: summary({
      status: 'failed', activeSlot: null, failureCode: 'dependency-install-failed',
      dispatchIdentity: null, installed: true, enabled: true, attentionReason: null,
      readinessProbes: 1, afterEnable: 1, notified: 1, resultRemoved: 1,
    }),
  },
  {
    name: 'leaves a restored but disabled reinstall closed',
    operation: 'reinstall',
    installed: true,
    enabled: false,
    state: { kind: 'terminal', result: failed('local-network-unavailable') },
    identities: [first],
    expected: summary({
      status: 'failed', activeSlot: null, failureCode: 'local-network-unavailable',
      dispatchIdentity: null, installed: true, enabled: false, attentionReason: null,
      readinessProbes: 1, notified: 1, resultRemoved: 1,
    }),
  },
  {
    name: 'keeps a reinstall gated when the routine may already have renamed a policy file',
    operation: 'reinstall',
    installed: true,
    state: { kind: 'terminal', result: failed('privileged-verification-failed') },
    identities: [first],
    expected: summary({
      status: 'failed', activeSlot: null, failureCode: 'partial-state-uncertain',
      dispatchIdentity: null, installed: true, enabled: true,
      attentionReason: 'partial-state-uncertain', notified: 1, resultRemoved: 1,
    }),
  },
  {
    name: 'keeps a reinstall gated when the result itself cannot be trusted',
    operation: 'reinstall',
    installed: true,
    state: { kind: 'terminal', result: { ...failed('interrupted'), jobId: 'zyxwvutsrqponmlk' } },
    identities: [first],
    expected: summary({
      status: 'failed', activeSlot: null, failureCode: 'partial-state-uncertain',
      dispatchIdentity: null, installed: true, enabled: true,
      attentionReason: 'partial-state-uncertain', notified: 1, resultRemoved: 1,
    }),
  },
  {
    name: 'keeps a pre-rename reinstall failure gated when the old policy no longer verifies',
    operation: 'reinstall',
    installed: true,
    state: { kind: 'terminal', result: failed('local-network-unavailable') },
    readiness: [POLICY_STALE],
    identities: [first],
    expected: summary({
      status: 'failed', activeSlot: null, failureCode: 'partial-state-uncertain',
      dispatchIdentity: null, installed: true, enabled: true,
      attentionReason: 'partial-state-uncertain', readinessProbes: 1, notified: 1, resultRemoved: 1,
    }),
  },
  {
    name: 'records uncertainty when a restored reinstall cannot reopen its runtime',
    operation: 'reinstall',
    installed: true,
    failAfterEnable: true,
    state: { kind: 'terminal', result: failed('local-network-unavailable') },
    identities: [first],
    expected: summary({
      status: 'failed', activeSlot: null, failureCode: 'local-network-unavailable',
      dispatchIdentity: null, installed: true, enabled: true,
      attentionReason: 'partial-state-uncertain',
      readinessProbes: 1, afterEnable: 1, notified: 1, resultRemoved: 1,
    }),
  },
  {
    name: 'treats a result marker as progress',
    given: 'queued',
    state: { kind: 'running' },
    identities: [first],
    expected: summary({ status: 'running', dispatchIdentity: null }),
  },
  {
    name: 'leaves a queued job untouched while the result is absent',
    given: 'queued',
    state: { kind: 'absent' },
    identities: [first],
    expected: summary({ status: 'queued', dispatchIdentity: null }),
  },
  {
    name: 'parks a terminal result that arrives before the running marker',
    given: 'queued',
    identities: [first],
    expected: summary({ dispatches: 1, preRestart: 1 }),
  },
  {
    name: 'waits instead of guessing when this process identity is unreadable',
    identities: [null],
    expected: summary({ status: 'running', dispatchIdentity: null }),
  },
  {
    name: 'waits on an awaiting-restart job while the process identity is unreadable',
    given: 'awaiting-restart',
    identities: [null],
    expected: summary({}),
  },
  {
    name: 'returns a verified job untouched on later ticks',
    identities: [first, second, second],
    expected: summary({
      status: 'succeeded', activeSlot: null, installed: true, enabled: true,
      dispatches: 1, readinessProbes: 1, afterEnable: 1, preRestart: 1, notified: 1, resultRemoved: 1,
    }),
  },
];

describe('ReconcileFeatureInstallUseCase', () => {
  it.each(scenarios)('$name', async (scenario) => {
    await expect(run(scenario)).resolves.toEqual(scenario.expected);
  });

  it('announces the pending restart before dispatch and the outcome only after fresh readiness', async () => {
    const scenario: Scenario = { identities: [], expected: summary() };
    const test = create(scenario);
    await arrange(test, scenario);
    const order: string[] = [];
    test.outcomes.notifyPreRestart.mockImplementation(async () => {
      expect(await test.jobs.findById(id)).toMatchObject({ status: 'awaiting-restart', activeSlot: 1 });
      expect(await test.features.findByName('digital')).toMatchObject({ installed: false, enabled: false });
      order.push('pre-restart');
    });
    test.restart.dispatch.mockImplementation(async () => { order.push('restart'); });
    test.results.removeTerminal.mockImplementation(async () => {
      expect(await test.jobs.findById(id)).toMatchObject({ status: 'succeeded', activeSlot: null });
      order.push('remove');
    });
    test.lifecycle.afterEnable.mockImplementation(async () => { order.push('gate'); });
    test.outcomes.notify.mockImplementation(async () => { order.push('notify'); });

    await test.useCase.execute(id);
    test.identity.value = second;
    await test.useCase.execute(id);

    expect(order).toEqual(['pre-restart', 'restart', 'remove', 'gate', 'notify']);
    expect(await test.features.findByName('digital')).toMatchObject({ installed: true, enabled: true, attentionReason: null });
  });

  it('coalesces concurrent reconciliations of the same job', async () => {
    const scenario: Scenario = { identities: [], expected: summary() };
    const test = create(scenario);
    await arrange(test, scenario);

    await Promise.all([test.useCase.execute(id), test.useCase.execute(id)]);

    expect(test.restart.dispatch).toHaveBeenCalledTimes(1);
    expect(test.outcomes.notifyPreRestart).toHaveBeenCalledTimes(1);
  });
});

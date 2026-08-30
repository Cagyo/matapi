import { describe, expect, it, vi } from 'vitest';
import { ArchiveProviderGateService } from '../../../src/archive/application/archive-provider-gate.service';
import { DrivePolicyBlockedError } from '../../../src/archive/domain/errors/drive-policy-blocked.error';
import { DriveProviderCapacityBlockedError } from '../../../src/archive/domain/errors/drive-provider-capacity-blocked.error';
import { DriveQuotaExceededError } from '../../../src/archive/domain/errors/drive-quota-exceeded.error';
import { DriveRateLimitedError } from '../../../src/archive/domain/errors/drive-rate-limited.error';
import { DriveReauthorizationRequiredError } from '../../../src/archive/domain/errors/drive-reauthorization-required.error';
import { DriveTemporaryUnavailableError } from '../../../src/archive/domain/errors/drive-temporary-unavailable.error';
import { InMemoryArchiveProviderStateRepository } from '../../../src/archive/infrastructure/persistence/in-memory-archive-provider-state.repository';

describe('ArchiveProviderGateService', () => {
  it('lets only one caller CAS-claim a due quota probe', async () => {
    const repository = new InMemoryArchiveProviderStateRepository();
    const clock = { value: 6 * 60 * 60_000 };
    const initial = await repository.load();
    await repository.compareAndSet(initial.revision, {
      generationId: 'generation-1',
      operationClass: 'upload',
      failureClass: 'quota',
      failureStreak: 1,
      cooldownUntilMs: clock.value,
      blockReason: 'quota_exhausted',
      updatedAtMs: 0,
    });
    const gate = new ArchiveProviderGateService(
      repository,
      { now: () => new Date(clock.value) },
    );

    const admission = await gate.inspect('generation-1', 'account');
    expect(admission).toMatchObject({ kind: 'probe', reason: 'quota', revision: 1 });
    if (admission.kind !== 'probe') throw new Error('expected a quota probe admission');
    const [left, right] = await Promise.all([
      gate.claimRecoveryProbe(admission),
      gate.claimRecoveryProbe(admission),
    ]);

    expect([left, right].filter(Boolean)).toHaveLength(1);
  });

  it('never offers a probe for reauthorization', async () => {
    const { repository, gate, clock } = await fixture();
    const current = await repository.load();
    await repository.compareAndSet(current.revision, {
      generationId: 'generation-1',
      operationClass: 'upload',
      failureClass: 'authorization',
      failureStreak: 1,
      cooldownUntilMs: clock.value,
      blockReason: 'reauthorization_required',
      updatedAtMs: clock.value,
    });

    await expect(gate.inspect('generation-1', 'upload')).resolves.toEqual({
      kind: 'blocked',
      reason: 'reauthorization_required',
    });
  });

  it('does not treat a clamped wait as provider recovery', async () => {
    const { repository, gate, clock } = await fixture();
    const current = await repository.load();
    await repository.compareAndSet(current.revision, {
      generationId: 'generation-1',
      operationClass: 'upload',
      failureClass: 'rate-limit',
      failureStreak: 1,
      cooldownUntilMs: clock.value + 24 * 60 * 60_000,
      blockReason: null,
      updatedAtMs: clock.value,
    });

    await gate.run({
      generationId: 'generation-1',
      operationClass: 'upload',
      probe: true,
      operation: vi.fn(async () => undefined),
    }).catch(() => undefined);

    expect((await repository.load()).failureClass).toBe('rate-limit');
  });

  it('rejects stale-generation inspection without reactivating old provider state', async () => {
    const { repository, gate } = await fixture();
    await gate.ensureGeneration('generation-1');
    await gate.ensureGeneration('generation-2');

    await expect(gate.inspect('generation-1', 'upload')).resolves.toEqual({
      kind: 'blocked',
      reason: 'stale_generation',
    });
    await expect(repository.load()).resolves.toMatchObject({
      generationId: 'generation-2',
    });
  });

  it.each(['success', 'failure'] as const)(
    'drops a stale in-flight %s outcome after explicit generation activation',
    async (outcome) => {
      const { repository, gate } = await fixture();
      await gate.ensureGeneration('generation-1');
      let release!: () => void;
      let started!: () => void;
      const didStart = new Promise<void>((resolve) => { started = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const running = gate.run({
        generationId: 'generation-1',
        operationClass: 'upload',
        operation: async () => {
          started();
          await hold;
          if (outcome === 'failure') throw new DrivePolicyBlockedError();
          return 'ok';
        },
      });
      await didStart;

      await gate.ensureGeneration('generation-2');
      release();
      if (outcome === 'failure') await expect(running).rejects.toBeInstanceOf(DrivePolicyBlockedError);
      else await expect(running).resolves.toBe('ok');

      await expect(repository.load()).resolves.toMatchObject({
        generationId: 'generation-2',
        blockReason: null,
      });
    },
  );

  it.each([
    {
      name: 'capacity',
      failureClass: 'capacity',
      blockReason: 'account_creation_limit',
    },
    {
      name: 'policy',
      failureClass: 'policy',
      blockReason: 'policy_blocked',
    },
    {
      name: 'reauthorization',
      failureClass: 'authorization',
      blockReason: 'reauthorization_required',
    },
  ] as const)(
    'does not overwrite or alert after runIfAllowed loses to newer $name state',
    async ({ failureClass, blockReason }) => {
      const repository = new InMemoryArchiveProviderStateRepository();
      const initial = await repository.load();
      await repository.activateGeneration(initial.revision, 'generation-1', 1_000);
      const settleProviderProbeFailure = vi.fn(async () => 'settled' as const);
      const gate = new ArchiveProviderGateService(
        repository,
        { now: () => new Date(2_000) },
        undefined,
        { random: () => 0.5 },
        {},
        { settleProviderProbeFailure },
      );
      let announceStarted!: () => void;
      let releaseOperation!: () => void;
      const started = new Promise<void>((resolve) => { announceStarted = resolve; });
      const hold = new Promise<void>((resolve) => { releaseOperation = resolve; });
      const staleFailure = new DriveProviderCapacityBlockedError('user-action');
      const running = gate.runIfAllowed({
        generationId: 'generation-1',
        operationClass: 'reconcile',
        operation: async () => {
          announceStarted();
          await hold;
          throw staleFailure;
        },
      });
      await started;
      const admitted = await repository.load();
      await repository.compareAndSet(admitted.revision, {
        generationId: 'generation-1',
        operationClass: 'upload',
        failureClass,
        failureStreak: 7,
        cooldownUntilMs: null,
        blockReason,
        updatedAtMs: 1_500,
      });
      const newer = await repository.load();
      const compareAndSet = vi.spyOn(repository, 'compareAndSet');

      releaseOperation();
      await expect(running).rejects.toBe(staleFailure);

      await expect(repository.load()).resolves.toEqual(newer);
      expect(compareAndSet).not.toHaveBeenCalled();
      expect(settleProviderProbeFailure).not.toHaveBeenCalled();
    },
  );

  it('does not let unrelated metadata success clear an upload cooldown', async () => {
    const { gate } = await fixture();
    await gate.recordFailure('generation-1', 'upload', new DriveRateLimitedError({
      retryAfterMs: 60_000, sessionUsable: false, operationPhase: 'session-chunk',
    }));

    await expect(gate.inspect('generation-1', 'account')).resolves.toMatchObject({ kind: 'cooldown' });
    await gate.recordSuccess('generation-1', 'account', false);

    await expect(gate.inspect('generation-1', 'upload')).resolves.toMatchObject({ kind: 'cooldown' });
  });

  it('does not let an unrelated operation claim or clear an upload recovery probe', async () => {
    const { gate, clock } = await fixture();
    await gate.recordFailure('generation-1', 'upload', new DriveRateLimitedError({
      retryAfterMs: 1_000, sessionUsable: true, operationPhase: 'metadata',
    }));
    clock.value += 1_001;

    await expect(gate.run({
      generationId: 'generation-1', operationClass: 'account', operation: async () => 'account-ok',
    })).rejects.toBeInstanceOf(DriveTemporaryUnavailableError);
    await expect(gate.inspect('generation-1', 'upload')).resolves.toMatchObject({
      kind: 'probe', reason: 'cooldown', operationClass: 'upload',
    });

    await expect(gate.run({
      generationId: 'generation-1', operationClass: 'upload', probe: true, operation: async () => 'upload-ok',
    })).resolves.toBe('upload-ok');
    await expect(gate.inspect('generation-1', 'upload')).resolves.toEqual({ kind: 'allowed' });
  });

  it('denies a foreign operation that does not explicitly request an upload-owned recovery probe', async () => {
    const { gate, clock } = await fixture();
    await gate.recordFailure('generation-1', 'upload', new DriveRateLimitedError({
      retryAfterMs: 1_000, sessionUsable: true, operationPhase: 'metadata',
    }));
    clock.value += 1_001;

    await expect(gate.run({
      generationId: 'generation-1', operationClass: 'folder', operation: async () => 'folder-ok',
    })).rejects.toBeInstanceOf(DriveTemporaryUnavailableError);
  });

  it('does not let an explicit foreign operation claim an expired upload cooldown', async () => {
    const { repository, gate, clock } = await fixture();
    await gate.recordFailure('generation-1', 'upload', new DriveRateLimitedError({
      retryAfterMs: 1_000, sessionUsable: true, operationPhase: 'metadata',
    }));
    clock.value += 1_001;

    await expect(gate.run({
      generationId: 'generation-1', operationClass: 'folder', probe: true, operation: async () => 'folder-ok',
    })).rejects.toBeInstanceOf(DriveTemporaryUnavailableError);
    await expect(repository.load()).resolves.toMatchObject({
      operationClass: 'upload', failureClass: 'rate-limit', cooldownUntilMs: 2_000,
    });
  });

  it('attributes a failed recovery probe to the exact operation that claimed it', async () => {
    const { repository, gate, clock } = await fixture();
    await gate.recordFailure('generation-1', 'upload', new DriveRateLimitedError({
      retryAfterMs: 1_000, sessionUsable: false, operationPhase: 'metadata',
    }));
    clock.value += 1_001;

    await expect(gate.run({
      generationId: 'generation-1',
      operationClass: 'upload',
      probe: true,
      operation: async () => { throw new DriveProviderCapacityBlockedError('temporary'); },
    })).rejects.toBeInstanceOf(DriveProviderCapacityBlockedError);
    await expect(repository.load()).resolves.toMatchObject({
      operationClass: 'upload',
      failureClass: 'capacity',
      failureStreak: 2,
      cooldownUntilMs: clock.value + 60 * 60 * 1_000,
    });
  });

  it.each([
    {
      name: 'capacity',
      error: new DriveProviderCapacityBlockedError('user-action'),
      failureClass: 'capacity',
      blockReason: 'account_creation_limit',
      alertKind: 'provider-capacity-blocked',
    },
    {
      name: 'policy',
      error: new DrivePolicyBlockedError(),
      failureClass: 'policy',
      blockReason: 'policy_blocked',
      alertKind: 'policy-rejected',
    },
    {
      name: 'quota',
      error: new DriveQuotaExceededError(),
      failureClass: 'quota',
      blockReason: 'quota_exhausted',
      alertKind: 'quota-reclamation-required',
    },
  ] as const)(
    'atomically settles a claimed probe that is reclassified as $name',
    async ({ error, failureClass, blockReason, alertKind }) => {
      const repository = new InMemoryArchiveProviderStateRepository();
      const nowMs = 10_000;
      const empty = await repository.load();
      await repository.compareAndSet(empty.revision, {
        generationId: 'generation-1',
        operationClass: 'upload',
        failureClass: 'policy',
        failureStreak: 1,
        cooldownUntilMs: nowMs,
        blockReason: 'policy_blocked',
        updatedAtMs: 0,
      });
      const settleProviderProbeFailure = vi.fn(async () => 'settled' as const);
      const compareAndSet = vi.spyOn(repository, 'compareAndSet');
      let activeRevision = 17;
      const loadActive = vi.fn(async () => ({
        id: 'generation-1',
        revision: activeRevision,
        status: 'active' as const,
      }));
      const gate = new ArchiveProviderGateService(
        repository,
        { now: () => new Date(nowMs) },
        undefined,
        { random: () => 0.5 },
        {},
        { settleProviderProbeFailure },
        { loadActive },
      );

      await expect(gate.run({
        generationId: 'generation-1',
        operationClass: 'upload',
        probe: true,
        operation: async () => {
          activeRevision = 18;
          throw error;
        },
      })).rejects.toBe(error);

      expect(loadActive).toHaveBeenCalledOnce();
      expect(settleProviderProbeFailure).toHaveBeenCalledOnce();
      expect(settleProviderProbeFailure).toHaveBeenCalledWith(expect.objectContaining({
        fence: { id: 'generation-1', revision: 17, status: 'active' },
        expectedProviderRevision: 2,
        alertKind,
        nowMs,
        alertCooldownUntilMs: nowMs + 60 * 60_000,
        nextProviderState: expect.objectContaining({
          generationId: 'generation-1',
          operationClass: 'upload',
          failureClass,
          failureStreak: 2,
          blockReason,
          updatedAtMs: nowMs,
        }),
      }));
      expect(compareAndSet).toHaveBeenCalledTimes(1);
    },
  );

  it('does not replace an upload cooldown when another operation fails retryably', async () => {
    const { gate } = await fixture();
    await gate.recordFailure('generation-1', 'upload', new DriveRateLimitedError({
      retryAfterMs: 60_000, sessionUsable: false, operationPhase: 'session-chunk',
    }));

    await gate.recordFailure('generation-1', 'account', new DriveTemporaryUnavailableError());

    await expect(gate.inspect('generation-1', 'upload')).resolves.toEqual({
      kind: 'cooldown', untilMs: 61_000,
    });
    await expect(gate.inspect('generation-1', 'account')).resolves.toEqual({
      kind: 'cooldown', untilMs: 61_000,
    });
  });

  it('does not replace an upload recovery probe when another operation fails retryably', async () => {
    const { gate, clock } = await fixture();
    await gate.recordFailure('generation-1', 'upload', new DriveRateLimitedError({
      retryAfterMs: 1_000, sessionUsable: true, operationPhase: 'metadata',
    }));
    clock.value += 1_001;

    await gate.recordFailure('generation-1', 'account', new DriveTemporaryUnavailableError());

    await expect(gate.inspect('generation-1', 'upload')).resolves.toMatchObject({
      kind: 'probe', reason: 'cooldown', operationClass: 'upload',
    });
    await expect(gate.inspect('generation-1', 'account')).resolves.toMatchObject({
      kind: 'probe', reason: 'cooldown', operationClass: 'upload',
    });
  });

  it('resets stale provider state when the active generation changes', async () => {
    const { repository, gate } = await fixture();
    const initial = await repository.load();
    await repository.activateGeneration(initial.revision, 'generation-1', 10);
    const generationOne = await repository.load();
    await repository.compareAndSet(generationOne.revision, {
      generationId: 'generation-1', operationClass: 'upload', failureClass: 'capacity',
      failureStreak: 1, cooldownUntilMs: null, blockReason: 'account_creation_limit', updatedAtMs: 11,
    });

    await expect(gate.ensureGeneration('generation-2')).resolves.toMatchObject({
      generationId: 'generation-2', blockReason: null, failureStreak: 0,
    });
  });

  it('uses all seven exponential slots with fresh jitter and leaves a durable deadline', async () => {
    const random = vi.fn()
      .mockReturnValueOnce(0.1).mockReturnValueOnce(0.2).mockReturnValueOnce(0.3)
      .mockReturnValueOnce(0.4).mockReturnValueOnce(0.5).mockReturnValueOnce(0.6)
      .mockReturnValue(0.7);
    const { gate, sleeps, clock } = await fixture({ random });
    const operation = vi.fn(async () => { throw new DriveTemporaryUnavailableError(); });

    await expect(gate.run({ generationId: 'generation-1', operationClass: 'upload', operation }))
      .rejects.toBeInstanceOf(DriveTemporaryUnavailableError);

    expect(operation).toHaveBeenCalledTimes(8);
    expect(sleeps).toEqual([1_100, 2_200, 4_300, 8_400, 16_500, 32_600, 64_700]);
    await expect(gate.inspect('generation-1', 'upload')).resolves.toEqual({
      kind: 'cooldown', untilMs: clock.value + 64_700,
    });
  });

  it('clamps a valid provider Retry-After to 24 hours', async () => {
    const { gate, clock } = await fixture();

    await gate.recordFailure('generation-1', 'upload', new DriveRateLimitedError({
      retryAfterMs: 48 * 60 * 60 * 1_000,
      sessionUsable: false,
      operationPhase: 'session-query',
    }));

    await expect(gate.inspect('generation-1', 'upload')).resolves.toEqual({
      kind: 'cooldown', untilMs: clock.value + 24 * 60 * 60 * 1_000,
    });
  });

  it('returns to the pump after one maximum sleep while a durable cooldown remains', async () => {
    const { gate, sleeps } = await fixture();
    await gate.recordFailure('generation-1', 'upload', new DriveRateLimitedError({
      retryAfterMs: 24 * 60 * 60 * 1_000,
      sessionUsable: false,
      operationPhase: 'session-query',
    }));
    const operation = vi.fn(async () => 'too early');

    await expect(gate.run({ generationId: 'generation-1', operationClass: 'upload', operation }))
      .rejects.toBeInstanceOf(DriveTemporaryUnavailableError);

    expect(sleeps).toEqual([120_000]);
    expect(operation).not.toHaveBeenCalled();
    await expect(gate.inspect('generation-1', 'upload')).resolves.toMatchObject({ kind: 'cooldown' });
  });

  it('does not retry before a provider-supplied Retry-After exceeds the in-process clamp', async () => {
    const { gate, sleeps } = await fixture();
    const operation = vi.fn(async () => { throw new DriveRateLimitedError({
      retryAfterMs: 240_000,
      sessionUsable: true,
      operationPhase: 'session-create',
    }); });

    await expect(gate.run({ generationId: 'generation-1', operationClass: 'upload', operation }))
      .rejects.toBeInstanceOf(DriveRateLimitedError);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([120_000]);
    await expect(gate.inspect('generation-1', 'upload')).resolves.toMatchObject({ kind: 'cooldown' });
  });

  it.each([
    { priorFailureStreak: 5, durableDelayMs: 32_000 },
    { priorFailureStreak: 6, durableDelayMs: 64_000 },
  ])(
    'does not retry a temporary failure when the $durableDelayMs ms deadline exceeds a 30s sleep cap',
    async ({ priorFailureStreak, durableDelayMs }) => {
      const repository = new InMemoryArchiveProviderStateRepository();
      const clock = { value: 1_000 };
      const empty = await repository.load();
      await repository.activateGeneration(empty.revision, 'generation-1', clock.value);
      const active = await repository.load();
      await repository.compareAndSet(active.revision, {
        generationId: 'generation-1',
        operationClass: 'upload',
        failureClass: 'transport',
        failureStreak: priorFailureStreak,
        cooldownUntilMs: null,
        blockReason: null,
        updatedAtMs: clock.value,
      });
      const sleeps: number[] = [];
      const gate = new ArchiveProviderGateService(
        repository,
        { now: () => new Date(clock.value) },
        {
          sleep: async (ms) => {
            sleeps.push(ms);
            clock.value += ms;
          },
        },
        { random: () => 0 },
        { maximumSleepMs: 30_000 },
      );
      const failure = new DriveTemporaryUnavailableError();
      const operation = vi.fn(async () => { throw failure; });

      await expect(gate.run({
        generationId: 'generation-1',
        operationClass: 'upload',
        operation,
      })).rejects.toBe(failure);

      expect(operation).toHaveBeenCalledOnce();
      expect(sleeps).toEqual([30_000]);
      await expect(repository.load()).resolves.toEqual({
        revision: 3,
        generationId: 'generation-1',
        operationClass: 'upload',
        failureClass: 'transport',
        failureStreak: priorFailureStreak + 1,
        cooldownUntilMs: 1_000 + durableDelayMs,
        blockReason: null,
        updatedAtMs: 1_000,
      });
    },
  );

  it.each([
    [new DriveProviderCapacityBlockedError('temporary'), 'cooldown'],
    [new DriveProviderCapacityBlockedError('user-action'), 'blocked'],
    [new DrivePolicyBlockedError(), 'blocked'],
    [new DriveReauthorizationRequiredError(), 'blocked'],
  ] as const)('persists provider-wide capacity, policy, and auth outcomes', async (error, kind) => {
    const { gate } = await fixture();

    await gate.recordFailure('generation-1', 'folder', error);

    await expect(gate.inspect('generation-1', 'folder')).resolves.toMatchObject({ kind });
  });

  it('returns temporary capacity control to the pump without sleeping for the one-hour deadline', async () => {
    const { gate, sleeps, clock } = await fixture();
    const operation = vi.fn(async () => { throw new DriveProviderCapacityBlockedError('temporary'); });

    await expect(gate.run({ generationId: 'generation-1', operationClass: 'upload', operation }))
      .rejects.toBeInstanceOf(DriveProviderCapacityBlockedError);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    await expect(gate.inspect('generation-1', 'upload')).resolves.toEqual({
      kind: 'cooldown', untilMs: clock.value + 60 * 60 * 1_000,
    });
  });

  it('applies a temporary capacity cooldown to every Drive operation in the generation', async () => {
    const { gate } = await fixture();
    await gate.recordFailure('generation-1', 'upload', new DriveProviderCapacityBlockedError('temporary'));

    await expect(gate.inspect('generation-1', 'folder')).resolves.toMatchObject({ kind: 'cooldown' });
    await expect(gate.inspect('generation-1', 'upload')).resolves.toMatchObject({ kind: 'cooldown' });
  });

  it.each([
    ['upload 429', 'upload', new DriveRateLimitedError({
      retryAfterMs: 60_000, sessionUsable: false, operationPhase: 'session-chunk',
    }), 'folder'],
    ['folder daily limit', 'folder', new DriveProviderCapacityBlockedError('temporary'), 'account'],
    ['reconcile outage', 'reconcile', new DriveTemporaryUnavailableError(), 'delete'],
  ] as const)('makes %s generation-wide', async (_scenario, owner, error, observer) => {
    const { gate } = await fixture();

    await gate.recordFailure('generation-1', owner, error);

    await expect(gate.inspect('generation-1', observer)).resolves.toMatchObject({ kind: 'cooldown' });
  });

  it('defers a quota block until retention, then lets only its due claim clear it', async () => {
    const { gate, clock } = await fixture();
    await gate.recordFailure('generation-1', 'upload', new DriveQuotaExceededError());
    await expect(gate.inspect('generation-1', 'upload')).resolves.toMatchObject({ kind: 'allowed' });

    await gate.recordQuotaOutcome('generation-1', 1);
    await expect(gate.inspect('generation-1', 'upload')).resolves.toEqual({
      kind: 'blocked', reason: 'quota_exhausted',
    });

    clock.value += 6 * 60 * 60_000;
    const admission = await gate.inspect('generation-1', 'upload');
    expect(admission).toMatchObject({ kind: 'probe', reason: 'quota' });
    if (admission.kind !== 'probe') throw new Error('expected a quota probe admission');
    const claim = await gate.claimRecoveryProbe(admission);
    expect(claim).not.toBeNull();
    await gate.recordQuotaOutcome('generation-1', 0, claim ?? undefined);
    await expect(gate.inspect('generation-1', 'upload')).resolves.toEqual({ kind: 'allowed' });
  });

  it('allows exactly an explicit post-cooldown probe and clears it on success', async () => {
    const { gate, clock } = await fixture();
    await gate.recordFailure('generation-1', 'upload', new DriveRateLimitedError({
      retryAfterMs: 1_000, sessionUsable: true, operationPhase: 'metadata',
    }));
    clock.value += 1_001;

    await expect(gate.inspect('generation-1', 'upload')).resolves.toMatchObject({
      kind: 'probe', reason: 'cooldown', operationClass: 'upload',
    });
    await expect(gate.run({
      generationId: 'generation-1', operationClass: 'upload', operation: async () => 'no probe',
    })).rejects.toBeInstanceOf(DriveTemporaryUnavailableError);
    await expect(gate.run({
      generationId: 'generation-1', operationClass: 'upload', probe: true, operation: async () => 'ok',
    })).resolves.toBe('ok');
    await expect(gate.inspect('generation-1', 'upload')).resolves.toEqual({ kind: 'allowed' });
  });

  it('clamps in-process waiting after wall-clock rollback and honors cancellation', async () => {
    const repository = new InMemoryArchiveProviderStateRepository();
    const initial = await repository.load();
    await repository.activateGeneration(initial.revision, 'generation-1', 100_000);
    const active = await repository.load();
    await repository.compareAndSet(active.revision, {
      generationId: 'generation-1', operationClass: 'upload', failureClass: 'rate-limit',
      failureStreak: 1, cooldownUntilMs: 200_000, blockReason: null, updatedAtMs: 100_000,
    });
    const controller = new AbortController();
    const sleep = vi.fn(async (ms: number, signal?: AbortSignal) => {
      expect(ms).toBe(5_000);
      controller.abort(new Error('cancelled'));
      if (signal?.aborted) throw signal.reason;
    });
    const gate = new ArchiveProviderGateService(
      repository, { now: () => new Date(1_000) }, { sleep }, { random: () => 0.5 }, { maximumSleepMs: 5_000 },
    );

    await expect(gate.run({
      generationId: 'generation-1', operationClass: 'upload',
      operation: async () => 'never', signal: controller.signal,
    })).rejects.toThrow('cancelled');
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('removes the abort listener after both timer settlement and cancellation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const repository = new InMemoryArchiveProviderStateRepository();
      const gate = new ArchiveProviderGateService(
        repository,
        { now: () => new Date(Date.now()) },
        undefined,
        { random: () => 0 },
        { maximumSleepMs: 5_000 },
      );
      await gate.ensureGeneration('generation-1');
      await gate.recordFailure('generation-1', 'upload', new DriveRateLimitedError({
        retryAfterMs: 100, sessionUsable: false, operationPhase: 'session-query',
      }));
      const settledController = new AbortController();
      const settledRemove = vi.spyOn(settledController.signal, 'removeEventListener');
      const settled = gate.run({
        generationId: 'generation-1', operationClass: 'upload',
        operation: async () => 'never', signal: settledController.signal,
      });
      const settledExpectation = expect(settled)
        .rejects.toBeInstanceOf(DriveTemporaryUnavailableError);

      await vi.advanceTimersByTimeAsync(100);
      await settledExpectation;
      expect(settledRemove).toHaveBeenCalledWith('abort', expect.any(Function));

      await gate.recordFailure('generation-1', 'upload', new DriveRateLimitedError({
        retryAfterMs: 5_000, sessionUsable: false, operationPhase: 'session-query',
      }));
      const cancelledController = new AbortController();
      const cancelledRemove = vi.spyOn(cancelledController.signal, 'removeEventListener');
      const cancelled = gate.run({
        generationId: 'generation-1', operationClass: 'upload',
        operation: async () => 'never', signal: cancelledController.signal,
      });
      const cancelledExpectation = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(0);
      cancelledController.abort(new DOMException('stop', 'AbortError'));

      await cancelledExpectation;
      expect(cancelledRemove).toHaveBeenCalledWith('abort', expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
  });
});

async function fixture(options: { random?: () => number } = {}) {
  const repository = new InMemoryArchiveProviderStateRepository();
  const clock = { value: 1_000 };
  const sleeps: number[] = [];
  const gate = new ArchiveProviderGateService(
    repository,
    { now: () => new Date(clock.value) },
    { sleep: async (ms: number) => { sleeps.push(ms); clock.value += ms; } },
    { random: options.random ?? (() => 0.5) },
    {},
    {
      settleProviderProbeFailure: async (input) => (
        await repository.compareAndSet(
          input.expectedProviderRevision,
          input.nextProviderState,
        ) ? 'settled' : 'lost'
      ),
    },
    {
      loadActive: async () => ({
        id: 'generation-1',
        revision: 1,
        status: 'active',
      }),
    },
  );
  await gate.ensureGeneration('generation-1');
  return { repository, clock, sleeps, gate };
}

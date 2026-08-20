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
  it('does not let unrelated metadata success clear an upload cooldown', async () => {
    const { gate } = fixture();
    await gate.recordFailure('generation-1', 'upload', new DriveRateLimitedError({
      retryAfterMs: 60_000, sessionUsable: false, operationPhase: 'session-chunk',
    }));

    await expect(gate.inspect('generation-1', 'account')).resolves.toEqual({ kind: 'allowed' });
    await gate.recordSuccess('generation-1', 'account', false);

    await expect(gate.inspect('generation-1', 'upload')).resolves.toMatchObject({ kind: 'cooldown' });
  });

  it('does not let an unrelated operation claim or clear an upload recovery probe', async () => {
    const { gate, clock } = fixture();
    await gate.recordFailure('generation-1', 'upload', new DriveRateLimitedError({
      retryAfterMs: 1_000, sessionUsable: true, operationPhase: 'metadata',
    }));
    clock.value += 1_001;

    await expect(gate.run({
      generationId: 'generation-1', operationClass: 'account', operation: async () => 'account-ok',
    })).resolves.toBe('account-ok');
    await expect(gate.inspect('generation-1', 'upload')).resolves.toEqual({ kind: 'probe' });

    await expect(gate.run({
      generationId: 'generation-1', operationClass: 'upload', probe: true, operation: async () => 'upload-ok',
    })).resolves.toBe('upload-ok');
    await expect(gate.inspect('generation-1', 'upload')).resolves.toEqual({ kind: 'allowed' });
  });

  it('does not replace an upload cooldown when another operation fails retryably', async () => {
    const { gate } = fixture();
    await gate.recordFailure('generation-1', 'upload', new DriveRateLimitedError({
      retryAfterMs: 60_000, sessionUsable: false, operationPhase: 'session-chunk',
    }));

    await gate.recordFailure('generation-1', 'account', new DriveTemporaryUnavailableError());

    await expect(gate.inspect('generation-1', 'upload')).resolves.toEqual({
      kind: 'cooldown', untilMs: 61_000,
    });
    await expect(gate.inspect('generation-1', 'account')).resolves.toEqual({ kind: 'allowed' });
  });

  it('does not replace an upload recovery probe when another operation fails retryably', async () => {
    const { gate, clock } = fixture();
    await gate.recordFailure('generation-1', 'upload', new DriveRateLimitedError({
      retryAfterMs: 1_000, sessionUsable: true, operationPhase: 'metadata',
    }));
    clock.value += 1_001;

    await gate.recordFailure('generation-1', 'account', new DriveTemporaryUnavailableError());

    await expect(gate.inspect('generation-1', 'upload')).resolves.toEqual({ kind: 'probe' });
    await expect(gate.inspect('generation-1', 'account')).resolves.toEqual({ kind: 'allowed' });
  });

  it('resets stale provider state when the active generation changes', async () => {
    const { repository, gate } = fixture();
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
    const { gate, sleeps, clock } = fixture({ random });
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
    const { gate, clock } = fixture();

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
    const { gate, sleeps } = fixture();
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
    const { gate, sleeps } = fixture();
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
    [new DriveProviderCapacityBlockedError('temporary'), 'cooldown'],
    [new DriveProviderCapacityBlockedError('user-action'), 'blocked'],
    [new DrivePolicyBlockedError(), 'blocked'],
    [new DriveReauthorizationRequiredError(), 'blocked'],
  ] as const)('persists provider-wide capacity, policy, and auth outcomes', async (error, kind) => {
    const { gate } = fixture();

    await gate.recordFailure('generation-1', 'folder', error);

    await expect(gate.inspect('generation-1', 'folder')).resolves.toMatchObject({ kind });
  });

  it('returns temporary capacity control to the pump without sleeping for the one-hour deadline', async () => {
    const { gate, sleeps, clock } = fixture();
    const operation = vi.fn(async () => { throw new DriveProviderCapacityBlockedError('temporary'); });

    await expect(gate.run({ generationId: 'generation-1', operationClass: 'upload', operation }))
      .rejects.toBeInstanceOf(DriveProviderCapacityBlockedError);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    await expect(gate.inspect('generation-1', 'upload')).resolves.toEqual({
      kind: 'cooldown', untilMs: clock.value + 60 * 60 * 1_000,
    });
  });

  it('scopes a temporary capacity cooldown to its failed operation', async () => {
    const { gate } = fixture();
    await gate.recordFailure('generation-1', 'upload', new DriveProviderCapacityBlockedError('temporary'));

    await expect(gate.inspect('generation-1', 'folder')).resolves.toEqual({ kind: 'allowed' });
    await expect(gate.inspect('generation-1', 'upload')).resolves.toMatchObject({ kind: 'cooldown' });
  });

  it('defers a quota block until the exact-ID retention outcome is known', async () => {
    const { gate } = fixture();
    await gate.recordFailure('generation-1', 'upload', new DriveQuotaExceededError());
    await expect(gate.inspect('generation-1', 'upload')).resolves.toMatchObject({ kind: 'allowed' });

    await gate.recordQuotaOutcome('generation-1', 1);
    await expect(gate.inspect('generation-1', 'upload')).resolves.toEqual({
      kind: 'blocked', reason: 'quota_exhausted',
    });

    await gate.recordQuotaOutcome('generation-1', 0);
    await expect(gate.inspect('generation-1', 'upload')).resolves.toEqual({ kind: 'allowed' });
  });

  it('allows exactly an explicit post-cooldown probe and clears it on success', async () => {
    const { gate, clock } = fixture();
    await gate.recordFailure('generation-1', 'upload', new DriveRateLimitedError({
      retryAfterMs: 1_000, sessionUsable: true, operationPhase: 'metadata',
    }));
    clock.value += 1_001;

    await expect(gate.inspect('generation-1', 'upload')).resolves.toEqual({ kind: 'probe' });
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
});

function fixture(options: { random?: () => number } = {}) {
  const repository = new InMemoryArchiveProviderStateRepository();
  const clock = { value: 1_000 };
  const sleeps: number[] = [];
  const gate = new ArchiveProviderGateService(
    repository,
    { now: () => new Date(clock.value) },
    { sleep: async (ms: number) => { sleeps.push(ms); clock.value += ms; } },
    { random: options.random ?? (() => 0.5) },
  );
  return { repository, clock, sleeps, gate };
}

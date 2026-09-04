import { describe, expect, it, vi } from 'vitest';
import { ArchiveProviderGateService } from '../../../src/archive/application/archive-provider-gate.service';
import type { ArchiveArtifactRepositoryPort } from '../../../src/archive/application/ports/archive-artifact-repository.port';
import type { ArchiveAdminAlertOutboxPort } from '../../../src/archive/application/ports/archive-admin-alert-outbox.port';
import type { DriveQuotaProbePort } from '../../../src/archive/application/ports/drive-quota-probe.port';
import { ProbeDriveQuotaRecoveryUseCase } from '../../../src/archive/application/use-cases/probe-drive-quota-recovery.use-case';
import { DriveConnection } from '../../../src/archive/domain/drive-connection.entity';
import { DriveTemporaryUnavailableError } from '../../../src/archive/domain/errors/drive-temporary-unavailable.error';
import { InMemoryArchiveProviderStateRepository } from '../../../src/archive/infrastructure/persistence/in-memory-archive-provider-state.repository';

describe('ProbeDriveQuotaRecoveryUseCase', () => {
  it('clears quota only when current free bytes fit the next eligible transfer', async () => {
    const fixture = await createFixture();
    fixture.artifacts.readNextEligibleTransferSize.mockResolvedValue(4_096);
    fixture.quota.readQuota.mockResolvedValue({
      limitBytes: 10_000,
      usageBytes: 5_000,
      usageInDriveBytes: 5_000,
      usageInDriveTrashBytes: 0,
    });

    await expect(fixture.useCase.execute(
      fixture.connection,
      fixture.admission,
      new AbortController().signal,
    )).resolves.toBe('recovered');

    expect((await fixture.providerState.load()).blockReason).toBeNull();
    expect(fixture.artifacts.readNextEligibleTransferSize).toHaveBeenCalledWith(
      'generation-1', fixture.nowMs, undefined,
    );
    expect(fixture.quota.readQuota).toHaveBeenCalledOnce();
  });

  it('accepts trashed Drive usage as a subset of total Drive usage', async () => {
    const fixture = await createFixture();
    fixture.artifacts.readNextEligibleTransferSize.mockResolvedValue(4_000);
    fixture.quota.readQuota.mockResolvedValue({
      limitBytes: 10_000,
      usageBytes: 6_000,
      usageInDriveBytes: 6_000,
      usageInDriveTrashBytes: 1_000,
    });

    await expect(fixture.useCase.execute(
      fixture.connection,
      fixture.admission,
      new AbortController().signal,
    )).resolves.toBe('recovered');

    expect((await fixture.providerState.load()).blockReason).toBeNull();
    expect(fixture.quota.readQuota).toHaveBeenCalledOnce();
  });

  it('treats a consistent over-quota account as zero available bytes', async () => {
    const fixture = await createFixture();
    fixture.artifacts.readNextEligibleTransferSize.mockResolvedValue(1);
    fixture.quota.readQuota.mockResolvedValue({
      limitBytes: 100,
      usageBytes: 120,
      usageInDriveBytes: 80,
      usageInDriveTrashBytes: 30,
    });

    await expect(fixture.useCase.execute(
      fixture.connection,
      fixture.admission,
      new AbortController().signal,
    )).resolves.toBe('still-blocked');

    expect(await fixture.providerState.load()).toMatchObject({
      blockReason: 'quota_exhausted',
      failureClass: 'quota',
      cooldownUntilMs: expect.any(Number),
    });
    expect(fixture.quota.readQuota).toHaveBeenCalledOnce();
  });

  it('re-arms a fresh bounded six-hour quota probe when the next object still does not fit', async () => {
    const fixture = await createFixture();
    fixture.artifacts.readNextEligibleTransferSize.mockResolvedValue(6_000);
    fixture.quota.readQuota.mockResolvedValue({
      limitBytes: 10_000,
      usageBytes: 5_000,
      usageInDriveBytes: 5_000,
      usageInDriveTrashBytes: 0,
    });

    await expect(fixture.useCase.execute(
      fixture.connection,
      fixture.admission,
      new AbortController().signal,
    )).resolves.toBe('still-blocked');

    const state = await fixture.providerState.load();
    expect(state).toMatchObject({ blockReason: 'quota_exhausted', failureClass: 'quota' });
    expect(state.cooldownUntilMs).toBeGreaterThan(fixture.nowMs);
    expect(state.cooldownUntilMs).toBeLessThanOrEqual(fixture.nowMs + 6 * 60 * 60_000);
    expect(fixture.artifacts.readNextEligibleTransferSize).toHaveBeenCalledOnce();
    expect(fixture.quota.readQuota).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'an unknown quota limit',
      quota: {
        limitBytes: null,
        usageBytes: 5_000,
        usageInDriveBytes: 5_000,
        usageInDriveTrashBytes: 0,
      },
    },
    {
      name: 'inconsistent provider counters',
      quota: {
        limitBytes: 10_000,
        usageBytes: 5_000,
        usageInDriveBytes: 5_001,
        usageInDriveTrashBytes: 1,
      },
    },
  ])('keeps the quota block for $name', async ({ quota }) => {
    const fixture = await createFixture();
    fixture.artifacts.readNextEligibleTransferSize.mockResolvedValue(1_000);
    fixture.quota.readQuota.mockResolvedValue(quota);

    await expect(fixture.useCase.execute(
      fixture.connection,
      fixture.admission,
      new AbortController().signal,
    )).resolves.toBe('still-blocked');

    await expect(fixture.providerState.load()).resolves.toMatchObject({
      blockReason: 'quota_exhausted',
      cooldownUntilMs: expect.any(Number),
    });
  });

  it('keeps the quota block and re-arms it after one provider failure', async () => {
    const fixture = await createFixture();
    fixture.artifacts.readNextEligibleTransferSize.mockResolvedValue(1_000);
    fixture.quota.readQuota.mockRejectedValue(new DriveTemporaryUnavailableError());

    await expect(fixture.useCase.execute(
      fixture.connection,
      fixture.admission,
      new AbortController().signal,
    )).resolves.toBe('still-blocked');

    const state = await fixture.providerState.load();
    expect(state.blockReason).toBe('quota_exhausted');
    expect(state.cooldownUntilMs).toBeGreaterThan(fixture.nowMs);
    expect(fixture.quota.readQuota).toHaveBeenCalledOnce();
  });

  it.each(['still-blocked', 'provider-error'] as const)(
    'atomically settles a claimed quota probe after a %s outcome',
    async (outcome) => {
      const settleProviderProbeFailure = vi.fn(async () => 'settled' as const);
      const fixture = await createFixture({ settleProviderProbeFailure });
      fixture.artifacts.readNextEligibleTransferSize.mockResolvedValue(6_000);
      if (outcome === 'provider-error') {
        fixture.quota.readQuota.mockRejectedValue(new DriveTemporaryUnavailableError());
      } else {
        fixture.quota.readQuota.mockResolvedValue({
          limitBytes: 10_000,
          usageBytes: 5_000,
          usageInDriveBytes: 5_000,
          usageInDriveTrashBytes: 0,
        });
      }
      const compareAndSet = vi.spyOn(fixture.providerState, 'compareAndSet');

      await expect(fixture.useCase.execute(
        fixture.connection,
        fixture.admission,
        new AbortController().signal,
      )).resolves.toBe('still-blocked');

      expect(settleProviderProbeFailure).toHaveBeenCalledOnce();
      expect(settleProviderProbeFailure).toHaveBeenCalledWith(expect.objectContaining({
        fence: { id: 'generation-1', revision: 1, status: 'active' },
        expectedProviderRevision: 3,
        alertKind: 'quota-reclamation-required',
        nowMs: fixture.nowMs,
        alertCooldownUntilMs: fixture.nowMs + 60 * 60_000,
        nextProviderState: expect.objectContaining({
          generationId: 'generation-1',
          operationClass: 'upload',
          failureClass: 'quota',
          blockReason: 'quota_exhausted',
          updatedAtMs: fixture.nowMs,
        }),
      }));
      expect(compareAndSet).toHaveBeenCalledTimes(1);
    },
  );

  it('does not clear quota when there is no eligible transfer to prove fits', async () => {
    const fixture = await createFixture();
    fixture.artifacts.readNextEligibleTransferSize.mockResolvedValue(null);
    fixture.quota.readQuota.mockResolvedValue({
      limitBytes: 10_000,
      usageBytes: 0,
      usageInDriveBytes: 0,
      usageInDriveTrashBytes: 0,
    });

    await expect(fixture.useCase.execute(
      fixture.connection,
      fixture.admission,
      new AbortController().signal,
    )).resolves.toBe('still-blocked');
    expect(fixture.quota.readQuota).toHaveBeenCalledOnce();
  });

  it('allows only one overlapping caller to perform the candidate and quota reads', async () => {
    const fixture = await createFixture();
    fixture.artifacts.readNextEligibleTransferSize.mockResolvedValue(1_000);
    let releaseQuota!: () => void;
    let announceQuota!: () => void;
    const quotaStarted = new Promise<void>((resolve) => { announceQuota = resolve; });
    const quotaGate = new Promise<void>((resolve) => { releaseQuota = resolve; });
    fixture.quota.readQuota.mockImplementation(async () => {
      announceQuota();
      await quotaGate;
      return {
        limitBytes: 10_000,
        usageBytes: 0,
        usageInDriveBytes: 0,
        usageInDriveTrashBytes: 0,
      };
    });
    const signal = new AbortController().signal;

    const first = fixture.useCase.execute(fixture.connection, fixture.admission, signal);
    await quotaStarted;
    await expect(fixture.useCase.execute(fixture.connection, fixture.admission, signal))
      .resolves.toBe('stale');
    releaseQuota();
    await expect(first).resolves.toBe('recovered');

    expect(fixture.artifacts.readNextEligibleTransferSize).toHaveBeenCalledOnce();
    expect(fixture.quota.readQuota).toHaveBeenCalledOnce();
  });
});

async function createFixture(options: {
  settleProviderProbeFailure?: ArchiveAdminAlertOutboxPort['settleProviderProbeFailure'];
} = {}) {
  const nowMs = 6 * 60 * 60_000;
  const providerState = new InMemoryArchiveProviderStateRepository();
  const empty = await providerState.load();
  await providerState.activateGeneration(empty.revision, 'generation-1', 0);
  const active = await providerState.load();
  await providerState.compareAndSet(active.revision, {
    generationId: 'generation-1',
    operationClass: 'upload',
    failureClass: 'quota',
    failureStreak: 1,
    cooldownUntilMs: nowMs,
    blockReason: 'quota_exhausted',
    updatedAtMs: 0,
  });
  const clock = { now: () => new Date(nowMs) };
  const gate = new ArchiveProviderGateService(
    providerState,
    clock,
    undefined,
    { random: () => 0.5 },
    {},
    {
      settleProviderProbeFailure: options.settleProviderProbeFailure ?? (async (input) => (
        await providerState.compareAndSet(
          input.expectedProviderRevision,
          input.nextProviderState,
        ) ? 'settled' : 'lost'
      )),
    },
  );
  const inspected = await gate.inspect('generation-1', 'upload');
  if (inspected.kind !== 'probe' || inspected.reason !== 'quota') {
    throw new Error('fixture did not create a due quota probe');
  }
  const artifacts = {
    readNextEligibleTransferSize: vi.fn<ArchiveArtifactRepositoryPort['readNextEligibleTransferSize']>(),
  };
  const quota = {
    readQuota: vi.fn<DriveQuotaProbePort['readQuota']>(),
  };
  const useCase = new ProbeDriveQuotaRecoveryUseCase(artifacts, quota, gate, clock);
  return {
    nowMs,
    providerState,
    artifacts,
    quota,
    useCase,
    admission: inspected,
    connection: DriveConnection.restore({
      id: 'generation-1',
      installationId: 'installation-1',
      status: 'active',
      revision: 1,
      permissionId: 'owner-1',
      email: null,
      displayName: null,
      folders: { rootId: 'root', motionId: 'motion', backupsId: 'backups' },
      createdAtMs: 0,
      updatedAtMs: 0,
      activatedAtMs: 0,
      retiredAtMs: null,
    }),
  };
}

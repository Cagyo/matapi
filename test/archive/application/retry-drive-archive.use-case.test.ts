import { describe, expect, it, vi } from 'vitest';
import { ArchiveWakeService } from '../../../src/archive/application/archive-wake.service';
import type { DriveFolderReservationRepositoryPort } from '../../../src/archive/application/ports/drive-folder-reservation-repository.port';
import type {
  ArchiveProviderBlockReason,
  ArchiveProviderFailureClass,
} from '../../../src/archive/application/ports/archive-provider-state-repository.port';
import { RetryDriveArchiveUseCase } from '../../../src/archive/application/use-cases/retry-drive-archive.use-case';
import { DriveFolderReservation } from '../../../src/archive/domain/drive-folder-reservation.entity';
import { InMemoryArchiveProviderStateRepository } from '../../../src/archive/infrastructure/persistence/in-memory-archive-provider-state.repository';

describe('RetryDriveArchiveUseCase', () => {
  it.each([
    ['account_creation_limit', 'capacity', 'scheduled'],
    ['policy_blocked', 'policy', 'scheduled'],
    ['quota_exhausted', 'quota', 'automatic-quota-probe'],
    ['reauthorization_required', 'authorization', 'reauthorize'],
  ] as const)(
    'handles %s without clearing it optimistically',
    async (reason, failureClass, expected) => {
      const fixture = await createFixture();
      const state = await seedBlocked(fixture, reason, failureClass);

      await expect(fixture.useCase.execute({
        generationId: 'generation-1',
        observedProviderRevision: state.revision,
      })).resolves.toBe(expected);

      const current = await fixture.providerState.load();
      expect(current.blockReason).toBe(reason);
      if (expected === 'scheduled') {
        expect(current.revision).toBe(state.revision + 1);
        expect(current.cooldownUntilMs).toBe(fixture.nowMs);
        expect(fixture.wake.snapshot()).toBe(1);
      } else {
        expect(current).toEqual(state);
        expect(fixture.wake.snapshot()).toBe(0);
      }
      expect(fixture.reservations.requestNextBlockedRevalidation).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['generation', { generationId: 'generation-stale', revisionOffset: 0 }],
    ['revision', { generationId: 'generation-1', revisionOffset: -1 }],
  ] as const)('changes nothing for a stale observed %s fence', async (_name, stale) => {
    const fixture = await createFixture();
    const state = await seedBlocked(fixture, 'policy_blocked', 'policy');
    const before = await fixture.providerState.load();

    await expect(fixture.useCase.execute({
      generationId: stale.generationId,
      observedProviderRevision: state.revision + stale.revisionOffset,
    })).resolves.toBe('stale');

    await expect(fixture.providerState.load()).resolves.toEqual(before);
    expect(fixture.reservations.requestNextBlockedRevalidation).not.toHaveBeenCalled();
    expect(fixture.wake.snapshot()).toBe(0);
  });

  it('schedules one branch probe when provider state is clear', async () => {
    const fixture = await createFixture();
    const clear = await fixture.providerState.load();
    fixture.reservations.requestNextBlockedRevalidation.mockResolvedValue(blockedReservation());

    await expect(fixture.useCase.execute({
      generationId: 'generation-1',
      observedProviderRevision: clear.revision,
    })).resolves.toBe('scheduled');

    expect(fixture.reservations.requestNextBlockedRevalidation).toHaveBeenCalledOnce();
    expect(fixture.reservations.requestNextBlockedRevalidation).toHaveBeenCalledWith({
      generationId: 'generation-1',
      nowMs: fixture.nowMs,
    });
    expect(fixture.wake.snapshot()).toBe(1);
    await expect(fixture.providerState.load()).resolves.toEqual(clear);
  });

  it('returns nothing-blocked without waking when no branch request is durable', async () => {
    const fixture = await createFixture();
    const clear = await fixture.providerState.load();
    fixture.reservations.requestNextBlockedRevalidation.mockResolvedValue(null);

    await expect(fixture.useCase.execute({
      generationId: 'generation-1',
      observedProviderRevision: clear.revision,
    })).resolves.toBe('nothing-blocked');

    expect(fixture.wake.snapshot()).toBe(0);
  });

  it('does not request a branch while a provider cooldown is active', async () => {
    const fixture = await createFixture();
    const current = await fixture.providerState.load();
    await fixture.providerState.compareAndSet(current.revision, {
      generationId: 'generation-1',
      operationClass: 'upload',
      failureClass: 'rate-limit',
      failureStreak: 1,
      cooldownUntilMs: fixture.nowMs + 1_000,
      blockReason: null,
      updatedAtMs: fixture.nowMs,
    });
    const cooldown = await fixture.providerState.load();

    await expect(fixture.useCase.execute({
      generationId: 'generation-1',
      observedProviderRevision: cooldown.revision,
    })).resolves.toBe('nothing-blocked');

    expect(fixture.reservations.requestNextBlockedRevalidation).not.toHaveBeenCalled();
    expect(fixture.wake.snapshot()).toBe(0);
  });

  it('does not wake when persisting the branch request fails', async () => {
    const fixture = await createFixture();
    const clear = await fixture.providerState.load();
    fixture.reservations.requestNextBlockedRevalidation.mockRejectedValue(
      new Error('injected durable branch request failure'),
    );

    await expect(fixture.useCase.execute({
      generationId: 'generation-1',
      observedProviderRevision: clear.revision,
    })).rejects.toThrow('injected durable branch request failure');

    expect(fixture.wake.snapshot()).toBe(0);
  });
});

async function createFixture() {
  const nowMs = 10_000;
  const providerState = new InMemoryArchiveProviderStateRepository();
  const empty = await providerState.load();
  await providerState.activateGeneration(empty.revision, 'generation-1', 0);
  const reservations = {
    requestNextBlockedRevalidation: vi.fn<
      DriveFolderReservationRepositoryPort['requestNextBlockedRevalidation']
    >(),
  };
  const wake = new ArchiveWakeService();
  const useCase = new RetryDriveArchiveUseCase(
    providerState,
    reservations,
    { now: () => new Date(nowMs) },
    wake,
  );
  return { nowMs, providerState, reservations, wake, useCase };
}

async function seedBlocked(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  blockReason: ArchiveProviderBlockReason,
  failureClass: ArchiveProviderFailureClass,
) {
  const current = await fixture.providerState.load();
  await fixture.providerState.compareAndSet(current.revision, {
    generationId: 'generation-1',
    operationClass: 'upload',
    failureClass,
    failureStreak: 1,
    cooldownUntilMs: blockReason === 'quota_exhausted' ? fixture.nowMs + 1_000 : null,
    blockReason,
    updatedAtMs: fixture.nowMs,
  });
  return fixture.providerState.load();
}

function blockedReservation(): DriveFolderReservation {
  return DriveFolderReservation.reserve({
    id: 'reservation-1',
    installationId: 'installation-1',
    generationId: 'generation-1',
    normalizedPath: '2026',
    level: 'year',
    segmentName: '2026',
    folderId: 'folder-1',
    parentFolderId: 'motion',
    nowMs: 0,
  }).block('detached', 'DRIVE_FOLDER_DETACHED', 1, 10_000);
}

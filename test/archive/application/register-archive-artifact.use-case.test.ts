import { describe, expect, it, vi } from 'vitest';
import { RegisterArchiveArtifactUseCase } from '../../../src/archive/application/use-cases/register-archive-artifact.use-case';
import { InMemoryArchiveArtifactRepository } from '../../../src/archive/infrastructure/persistence/in-memory-archive-artifact.repository';
import { ArchiveWakeService } from '../../../src/archive/application/archive-wake.service';
import type { ClockPort } from '../../../src/events/domain/ports/clock.port';

const input = {
  installationId: '00000000-0000-4000-8000-000000000001', kind: 'motion_video' as const,
  sourceIdentity: 'motion:2026/07/29/120000-12345.mp4', trustedPath: '/motion/2026/07/29/120000-12345.mp4',
  relativePath: '2026/07/29/120000-12345.mp4', size: 42, mtimeNs: '1000', sourceTimeMs: 1_785_297_600_000,
  sha256: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64),
};

describe('RegisterArchiveArtifactUseCase', () => {
  it('returns one artifact when concurrent callers register the same fingerprint', async () => {
    const registration = new RegisterArchiveArtifactUseCase(
      new InMemoryArchiveArtifactRepository(),
      { now: () => new Date(2_000) },
      new ArchiveWakeService(),
    );

    const [left, right] = await Promise.all([registration.register(input), registration.register(input)]);

    expect(left.id).toBe(right.id);
  });

  it('records successful registration before waking the continuous pump', async () => {
    const order: string[] = [];
    const repository = {
      register: vi.fn(async () => {
        order.push('register');
        return { id: 'artifact-1' };
      }),
      readSchedulerState: vi.fn(async () => ({
        revision: 4, backupLeaseOwner: null, backupLeaseExpiresAtMs: null,
        lastBackupSuccessMs: null, lastUploadSuccessMs: null,
        lastReconcileSuccessMs: null, lastCleanupSuccessMs: null,
        lastArtifactRegistrationSuccessMs: null,
      })),
      compareAndSetSchedulerState: vi.fn(async () => {
        order.push('persist-success');
        return true;
      }),
    };
    const wake = new ArchiveWakeService();
    vi.spyOn(wake, 'wake').mockImplementation(() => { order.push('wake'); });
    const clock: ClockPort = { now: () => new Date(2_000) };
    const registration = new RegisterArchiveArtifactUseCase(repository as never, clock, wake);

    await registration.register(input);

    expect(repository.compareAndSetSchedulerState).toHaveBeenCalledWith(4, {
      lastArtifactRegistrationSuccessMs: 2_000,
    });
    expect(order).toEqual(['register', 'persist-success', 'wake']);
  });
});

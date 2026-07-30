import { describe, expect, it } from 'vitest';
import { RegisterArchiveArtifactUseCase } from '../../../src/archive/application/use-cases/register-archive-artifact.use-case';
import { InMemoryArchiveArtifactRepository } from '../../../src/archive/infrastructure/persistence/in-memory-archive-artifact.repository';

describe('RegisterArchiveArtifactUseCase', () => {
  it('returns one artifact when concurrent callers register the same fingerprint', async () => {
    const registration = new RegisterArchiveArtifactUseCase(new InMemoryArchiveArtifactRepository());
    const input = {
      installationId: '00000000-0000-4000-8000-000000000001', kind: 'motion_video' as const,
      sourceIdentity: 'motion:2026/07/29/120000-12345.mp4', trustedPath: '/motion/2026/07/29/120000-12345.mp4',
      relativePath: '2026/07/29/120000-12345.mp4', size: 42, mtimeNs: '1000', sourceTimeMs: 1_785_297_600_000,
      sha256: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64),
    };

    const [left, right] = await Promise.all([registration.register(input), registration.register(input)]);

    expect(left.id).toBe(right.id);
  });
});

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it, vi } from 'vitest';
import { ArchiveModule } from '../../../src/archive/archive.module';
import {
  ARCHIVE_ARTIFACT_REPOSITORY,
} from '../../../src/archive/application/ports/archive-artifact-repository.port';
import {
  ARCHIVE_REGISTRATION_LOOKUP,
  type ArchiveRegistrationLookupInput,
} from '../../../src/archive/application/ports/archive-registration-lookup.port';
import {
  FindRegisteredArchiveArtifactUseCase,
} from '../../../src/archive/application/use-cases/find-registered-archive-artifact.use-case';
import { ArchiveArtifact } from '../../../src/archive/domain/archive-artifact.entity';
import { DrizzleArchiveArtifactRepository } from '../../../src/archive/infrastructure/persistence/drizzle-archive-artifact.repository';
import { InMemoryArchiveArtifactRepository } from '../../../src/archive/infrastructure/persistence/in-memory-archive-artifact.repository';
import * as schema from '../../../src/database/schema';

const registeredSource: ArchiveRegistrationLookupInput = {
  installationId: 'installation-1',
  kind: 'motion_video',
  sourceIdentity: 'motion:2026/08/29/123456-event.mp4',
  size: 42,
  mtimeNs: '1787992496000000000',
};

describe('FindRegisteredArchiveArtifactUseCase', () => {
  it('forwards the complete immutable source identity and returns only the artifact reference', async () => {
    const repository = {
      findRegisteredSource: vi.fn(async () => ({ artifactId: 'artifact-1' })),
    };
    const lookup = new FindRegisteredArchiveArtifactUseCase(repository);

    await expect(lookup.findKnown(registeredSource)).resolves.toEqual({ artifactId: 'artifact-1' });
    expect(repository.findRegisteredSource).toHaveBeenCalledOnce();
    expect(repository.findRegisteredSource).toHaveBeenCalledWith(registeredSource);
  });

  it('uses identical equality for every indexed registration field in memory', async () => {
    const repository = new InMemoryArchiveArtifactRepository();
    const artifact = await repository.register({
      ...registeredSource,
      trustedPath: '/motion/2026/08/29/123456-event.mp4',
      relativePath: '2026/08/29/123456-event.mp4',
      sourceTimeMs: 1_787_992_496_000,
      sha256: 'a'.repeat(64),
      sourceFingerprint: 'b'.repeat(64),
    });
    const lookup = new FindRegisteredArchiveArtifactUseCase(repository);

    await expect(lookup.findKnown(registeredSource)).resolves.toEqual({ artifactId: artifact.id });
    const mismatches: ArchiveRegistrationLookupInput[] = [
      { ...registeredSource, installationId: 'installation-2' },
      { ...registeredSource, sourceIdentity: 'motion:2026/08/29/123457-event.mp4' },
      { ...registeredSource, size: registeredSource.size + 1 },
      { ...registeredSource, mtimeNs: '1787992496000000001' },
    ];
    for (const mismatch of mismatches) {
      await expect(lookup.findKnown(mismatch)).resolves.toBeNull();
    }
  });

  it('chooses the lowest duplicate artifact ID in both persistence adapters', async () => {
    const inMemory = new InMemoryArchiveArtifactRepository();
    const inMemoryArtifacts = (inMemory as unknown as {
      artifacts: Map<string, ArchiveArtifact>;
    }).artifacts;
    inMemoryArtifacts.set('artifact-z', duplicateArtifact('artifact-z', 'c'));
    inMemoryArtifacts.set('artifact-a', duplicateArtifact('artifact-a', 'd'));

    const sqlite = new Database(':memory:');
    try {
      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: './migrations' });
      const drizzleRepository = new DrizzleArchiveArtifactRepository(db);
      const first = await drizzleRepository.register(duplicateInput('c'));
      const second = await drizzleRepository.register(duplicateInput('d'));
      sqlite.prepare('update archive_artifacts set id = ? where id = ?').run('artifact-z', first.id);
      sqlite.prepare('update archive_artifacts set id = ? where id = ?').run('artifact-a', second.id);

      await expect(inMemory.findRegisteredSource(registeredSource)).resolves.toEqual({ artifactId: 'artifact-a' });
      await expect(drizzleRepository.findRegisteredSource(registeredSource)).resolves.toEqual({ artifactId: 'artifact-a' });
    } finally {
      sqlite.close();
    }
  });

  it('exports only the provider-neutral lookup token, never the artifact repository', () => {
    const exports = Reflect.getMetadata('exports', ArchiveModule) as unknown[];

    expect(exports).toContain(ARCHIVE_REGISTRATION_LOOKUP);
    expect(exports).not.toContain(ARCHIVE_ARTIFACT_REPOSITORY);
    expect(exports).not.toContain(InMemoryArchiveArtifactRepository);
  });
});

function duplicateInput(sourceFingerprintSuffix: string) {
  return {
    ...registeredSource,
    trustedPath: '/motion/2026/08/29/123456-event.mp4',
    relativePath: '2026/08/29/123456-event.mp4',
    sourceTimeMs: 1_787_992_496_000,
    sha256: 'a'.repeat(64),
    sourceFingerprint: sourceFingerprintSuffix.repeat(64),
  };
}

function duplicateArtifact(id: string, sourceFingerprintSuffix: string): ArchiveArtifact {
  return ArchiveArtifact.register(duplicateInput(sourceFingerprintSuffix), { id, nowMs: 1 });
}

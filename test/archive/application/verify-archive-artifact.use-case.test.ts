import { describe, expect, it } from 'vitest';
import type { ArchiveUploadSourcePort } from '../../../src/archive/application/use-cases/upload-drive-object-attempt.use-case';
import { VerifyArchiveArtifactUseCase } from '../../../src/archive/application/use-cases/verify-archive-artifact.use-case';
import { encodeArchiveAppProperties } from '../../../src/archive/domain/app-properties';
import { DriveConnection } from '../../../src/archive/domain/drive-connection.entity';
import type { VerifiedDriveObject } from '../../../src/archive/domain/drive-object-metadata.value-object';
import { InMemoryArchiveArtifactRepository } from '../../../src/archive/infrastructure/persistence/in-memory-archive-artifact.repository';

const DIGEST = '25bf8e1a2393f1108d37029b3df5593236c755742ec93465bbafa9b290bddcf6';
const FINGERPRINT = 'b'.repeat(64);

describe('VerifyArchiveArtifactUseCase', () => {
  it('returns cleanup-safe only after a current-generation exact-ID read and unchanged local digest', async () => {
    const fixture = await setup();

    await expect(fixture.verification.inspect(fixture.artifactId)).resolves.toEqual({
      artifactId: fixture.artifactId,
      cleanupSafe: true,
      webViewLink: 'https://drive.example/file-1',
      reason: 'verified',
    });
    expect(fixture.loadedIds).toEqual(['file-1']);
  });

  it('fails closed when local bytes changed even if size and mtime stayed the same', async () => {
    const fixture = await setup('other');

    await expect(fixture.verification.inspect(fixture.artifactId)).resolves.toMatchObject({
      cleanupSafe: false,
      webViewLink: 'https://drive.example/file-1',
      reason: 'local-changed',
    });
  });

  it('fences a verified attempt from a retired generation', async () => {
    const fixture = await setup('local', 'generation-2');

    await expect(fixture.verification.inspect(fixture.artifactId)).resolves.toMatchObject({
      cleanupSafe: false,
      webViewLink: null,
      reason: 'retired-generation',
    });
    expect(fixture.loadedIds).toEqual([]);
  });

  it('returns detached when any exact remote metadata no longer matches', async () => {
    const fixture = await setup();
    fixture.remote.version = '2';

    await expect(fixture.verification.inspect(fixture.artifactId)).resolves.toMatchObject({
      cleanupSafe: false,
      webViewLink: null,
      reason: 'detached',
    });
  });
});

async function setup(local = 'local', activeGeneration = 'generation-1') {
  const repository = new InMemoryArchiveArtifactRepository();
  const connection = DriveConnection.restore({
    id: 'generation-1', installationId: 'installation-1', status: 'active', revision: 1,
    permissionId: 'owner-1', email: null, displayName: null,
    folders: { rootId: 'root-1', motionId: 'motion-1', backupsId: 'backups-1' },
    createdAtMs: 1, updatedAtMs: 1, activatedAtMs: 1, retiredAtMs: null,
  });
  const active = DriveConnection.restore({ ...connection, id: activeGeneration });
  const artifact = await repository.register({
    installationId: 'installation-1', kind: 'motion_video', sourceIdentity: 'motion:clip',
    trustedPath: '/motion/clip.mp4', relativePath: 'clip.mp4', size: 5,
    mtimeNs: '500000000', sourceTimeMs: 500, sha256: DIGEST, sourceFingerprint: FINGERPRINT,
  });
  const attempt = await repository.createAttempt(artifact.id, connection.id, 'file-1', 'motion-1', 1_000);
  const claimed = await repository.claimAttempt(attempt.id, { owner: 'upload', nowMs: 1_100, leaseMs: 10_000 });
  const remote = remoteObject();
  await repository.markVerified(attempt.id, claimed.lease, {
    objectId: remote.id, name: remote.name, containerId: remote.parentId, contentType: remote.mimeType,
    size: remote.size, sha256: remote.sha256, md5: remote.md5, providerCreatedAtMs: remote.createdTimeMs,
    revisionId: remote.headRevisionId, version: remote.version, ownedByInstallation: remote.ownedByMe,
    canDelete: remote.canDelete, trashed: remote.trashed, attributes: remote.appProperties,
    sharing: remote.sharing, webViewLink: remote.webViewLink,
  }, 1_200);
  const loadedIds: string[] = [];
  const source: ArchiveUploadSourcePort = {
    stat: async () => ({ size: 5, mtimeNs: '500000000' }),
    open: async function* () { yield Buffer.from(local); },
  };
  const verification = new VerifyArchiveArtifactUseCase(
    repository,
    { loadActive: async () => active },
    {
      loadObject: async (_connection, id) => { loadedIds.push(id); return remote; },
    },
    source,
  );
  return { verification, artifactId: artifact.id, remote, loadedIds };
}

function remoteObject(): VerifiedDriveObject {
  return {
    id: 'file-1', name: 'clip.mp4', parentId: 'motion-1', mimeType: 'video/mp4', size: 5,
    sha256: DIGEST, md5: 'c'.repeat(32), createdTimeMs: 1_000, headRevisionId: 'head-1', version: '1',
    ownedByMe: true, canDelete: true, trashed: false,
    appProperties: encodeArchiveAppProperties({
      installationId: 'installation-1', generationId: 'generation-1', kind: 'motion_video',
      sourceFingerprint: FINGERPRINT, sha256: DIGEST, sourceTimeMs: 500, schemaVersion: 1,
    }),
    sharing: { ownerPermissionId: 'owner-1', shared: false, permissionIds: ['owner-1'] },
    webViewLink: 'https://drive.example/file-1',
  };
}

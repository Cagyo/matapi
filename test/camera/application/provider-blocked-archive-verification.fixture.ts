import { createHash } from 'node:crypto';
import { ArchiveProviderGateService } from '../../../src/archive/application/archive-provider-gate.service';
import { VerifyArchiveArtifactUseCase } from '../../../src/archive/application/use-cases/verify-archive-artifact.use-case';
import { encodeArchiveAppProperties } from '../../../src/archive/domain/app-properties';
import { DriveConnection } from '../../../src/archive/domain/drive-connection.entity';
import { DrivePolicyBlockedError } from '../../../src/archive/domain/errors/drive-policy-blocked.error';
import { DriveRateLimitedError } from '../../../src/archive/domain/errors/drive-rate-limited.error';
import type { VerifiedDriveObject } from '../../../src/archive/domain/drive-object-metadata.value-object';
import { InMemoryArchiveArtifactRepository } from '../../../src/archive/infrastructure/persistence/in-memory-archive-artifact.repository';
import { InMemoryArchiveProviderStateRepository } from '../../../src/archive/infrastructure/persistence/in-memory-archive-provider-state.repository';

export async function providerBlockedArchiveVerification(
  admission: 'blocked' | 'cooldown' = 'blocked',
): Promise<{
  artifactId: string;
  verification: VerifyArchiveArtifactUseCase;
  loadedIds: string[];
}> {
  const content = Buffer.from('local');
  const digest = createHash('sha256').update(content).digest('hex');
  const fingerprint = 'b'.repeat(64);
  const repository = new InMemoryArchiveArtifactRepository();
  const connection = DriveConnection.restore({
    id: 'generation-1', installationId: 'installation-1', status: 'active', revision: 1,
    permissionId: 'owner-1', email: null, displayName: null,
    folders: { rootId: 'root-1', motionId: 'motion-1', backupsId: 'backups-1' },
    createdAtMs: 1, updatedAtMs: 1, activatedAtMs: 1, retiredAtMs: null,
  });
  const artifact = await repository.register({
    installationId: 'installation-1', kind: 'motion_video', sourceIdentity: 'motion:clip',
    trustedPath: '/motion/clip.mp4', relativePath: '2026/08/13/clip.mp4', size: content.length,
    mtimeNs: '500000000', sourceTimeMs: 500, sha256: digest, sourceFingerprint: fingerprint,
  });
  const attempt = await repository.createAttempt(
    artifact.id, connection.id, 'file-1', 'motion-1', 1_000,
  );
  const claimed = await repository.claimAttempt(attempt.id, {
    owner: 'upload', nowMs: 1_100, leaseMs: 10_000,
  });
  const remote: VerifiedDriveObject = {
    id: 'file-1', name: 'clip.mp4', parentId: 'motion-1', mimeType: 'video/mp4',
    size: content.length, sha256: digest, md5: null, createdTimeMs: 1_000,
    headRevisionId: 'head-1', version: '1', ownedByMe: true, canDelete: true,
    trashed: false,
    appProperties: encodeArchiveAppProperties({
      installationId: 'installation-1', generationId: connection.id,
      kind: 'motion_video', sourceFingerprint: fingerprint, sha256: digest,
      sourceTimeMs: 500, schemaVersion: 1,
    }),
    sharing: { ownerPermissionId: 'owner-1', shared: false, permissionIds: ['owner-1'] },
    webViewLink: 'https://drive.example/file-1',
  };
  await repository.markVerified(attempt.id, claimed.lease, {
    objectId: remote.id, name: remote.name, containerId: remote.parentId,
    contentType: remote.mimeType, size: remote.size, sha256: remote.sha256,
    md5: remote.md5, providerCreatedAtMs: remote.createdTimeMs,
    revisionId: remote.headRevisionId, version: remote.version,
    ownedByInstallation: remote.ownedByMe, canDelete: remote.canDelete,
    trashed: remote.trashed, attributes: remote.appProperties,
    sharing: remote.sharing, webViewLink: remote.webViewLink,
  }, 1_200);
  const providerState = new InMemoryArchiveProviderStateRepository();
  const gate = new ArchiveProviderGateService(providerState, { now: () => new Date(2_000) });
  await gate.ensureGeneration(connection.id);
  await gate.recordFailure(
    connection.id,
    'reconcile',
    admission === 'blocked'
      ? new DrivePolicyBlockedError()
      : new DriveRateLimitedError({
        retryAfterMs: 60_000,
        sessionUsable: false,
        operationPhase: 'metadata',
      }),
  );
  const loadedIds: string[] = [];
  const verification = new (VerifyArchiveArtifactUseCase as unknown as new (
    ...args: unknown[]
  ) => VerifyArchiveArtifactUseCase)(
    repository,
    { loadActive: async () => connection },
    { loadObject: async (_connection: unknown, id: string) => {
      loadedIds.push(id);
      return remote;
    } },
    {
      stat: async () => ({ size: content.length, mtimeNs: '500000000' }),
      open: async function* () { yield content; },
    },
    undefined,
    gate,
  );
  return { artifactId: artifact.id, verification, loadedIds };
}

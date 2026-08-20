import { Inject, Injectable } from '@nestjs/common';
import {
  ARCHIVE_ARTIFACT_REPOSITORY,
  type ArchiveArtifactRepositoryPort,
} from '../ports/archive-artifact-repository.port';
import {
  type ArchiveVerification,
  type ArchiveVerificationPort,
} from '../ports/archive-verification.port';
import {
  DRIVE_ARCHIVE,
  type DriveArchivePort,
} from '../ports/drive-archive.port';
import {
  DRIVE_CREDENTIAL_REPOSITORY,
  type DriveCredentialRepositoryPort,
} from '../ports/drive-credential-repository.port';
import {
  ARCHIVE_UPLOAD_SOURCE,
  type ArchiveUploadSourcePort,
} from './upload-drive-object-attempt.use-case';
import {
  classifyRemoteObject,
  hasUnchangedTrustedSource,
} from '../archive-object-verification';
import { ArchiveRemoteMutationLockService } from '../archive-remote-mutation-lock.service';
import type { ArchiveProviderGateService } from '../archive-provider-gate.service';

/** Fresh exact-ID verification used at every local-cleanup/link decision. */
@Injectable()
export class VerifyArchiveArtifactUseCase implements ArchiveVerificationPort {
  constructor(
    @Inject(ARCHIVE_ARTIFACT_REPOSITORY)
    private readonly repository: Pick<ArchiveArtifactRepositoryPort,
      'loadArtifact' | 'loadAttempt' | 'listAttempts' | 'markDetached' |
      'acceptReconciledRename'>,
    @Inject(DRIVE_CREDENTIAL_REPOSITORY)
    private readonly credentials: Pick<DriveCredentialRepositoryPort, 'loadActive'>,
    @Inject(DRIVE_ARCHIVE)
    private readonly drive: Pick<DriveArchivePort, 'loadObject'>,
    @Inject(ARCHIVE_UPLOAD_SOURCE)
    private readonly source: ArchiveUploadSourcePort,
    private readonly lock: Pick<ArchiveRemoteMutationLockService, 'runExclusive'> =
      new ArchiveRemoteMutationLockService(),
    private readonly providerGate?: Pick<ArchiveProviderGateService, 'runIfAllowed'>,
  ) {}

  async inspect(artifactId: string): Promise<ArchiveVerification> {
    const artifact = await this.repository.loadArtifact(artifactId);
    if (artifact === null) {
      return this.result(artifactId, 'no-current-attempt');
    }
    if (artifact.currentVerifiedAttemptId === null) {
      const attempts = await this.repository.listAttempts(artifactId);
      const latest = attempts.at(-1);
      if (latest?.state === 'missing') return this.result(artifactId, 'missing');
      if (latest?.state === 'detached') return this.result(artifactId, 'detached');
      if (latest?.state === 'conflict') return this.result(artifactId, 'conflict');
      if (latest !== undefined && ['pending', 'retryable', 'uploading'].includes(latest.state)) {
        return this.result(artifactId, 'busy');
      }
      return this.result(artifactId, 'no-current-attempt');
    }
    const attempt = await this.repository.loadAttempt(artifact.currentVerifiedAttemptId);
    if (attempt === null) return this.result(artifactId, 'no-current-attempt');
    if (attempt.state === 'missing') return this.result(artifactId, 'missing');
    if (attempt.state === 'detached') return this.result(artifactId, 'detached');
    if (attempt.state === 'conflict') return this.result(artifactId, 'conflict');
    if (attempt.state !== 'verified' || attempt.verifiedObject === null) {
      return this.result(artifactId, 'busy');
    }
    const active = await this.credentials.loadActive();
    if (active?.status !== 'active' || active.folders === null
      || active.id !== attempt.generationId
      || active.installationId !== artifact.installationId) {
      return this.result(artifactId, 'retired-generation');
    }
    const signal = new AbortController().signal;
    const admitted = this.providerGate === undefined
      ? { kind: 'executed' as const, value: await this.drive.loadObject(
        active,
        attempt.remoteObjectId,
        signal,
      ) }
      : await this.providerGate.runIfAllowed({
        generationId: active.id,
        operationClass: 'reconcile',
        operation: () => this.drive.loadObject(active, attempt.remoteObjectId, signal),
        signal,
      });
    if (admitted.kind === 'denied') return this.result(artifactId, 'busy');
    const remote = admitted.value;
    const confirmedActive = await this.credentials.loadActive();
    if (confirmedActive?.status !== 'active'
      || confirmedActive.id !== active.id
      || confirmedActive.installationId !== active.installationId) {
      return this.result(artifactId, 'retired-generation');
    }
    const classification = classifyRemoteObject(artifact, attempt, active, remote);
    if (classification === 'missing') return this.result(artifactId, 'missing');
    if (classification === 'detached') {
      await this.lock.runExclusive(() => this.repository.markDetached(
        attempt.id,
        attempt.revision,
        'remote_metadata_changed',
        Date.now(),
      ));
      return this.result(artifactId, 'detached');
    }
    if (classification === 'rename' && remote !== null) {
      await this.lock.runExclusive(() => this.repository.acceptReconciledRename(
        attempt.id,
        attempt.revision,
        remote.name,
        remote.version,
        Date.now(),
      ));
    }
    const webViewLink = remote?.webViewLink ?? null;
    if (!(await hasUnchangedTrustedSource(artifact, this.source, signal))) {
      return {
        artifactId,
        cleanupSafe: false,
        webViewLink,
        reason: 'local-changed',
      };
    }
    return {
      artifactId,
      cleanupSafe: true,
      webViewLink,
      reason: 'verified',
    };
  }

  private result(
    artifactId: string,
    reason: Exclude<ArchiveVerification['reason'], 'verified' | 'local-changed'>,
  ): ArchiveVerification {
    return { artifactId, cleanupSafe: false, webViewLink: null, reason };
  }
}

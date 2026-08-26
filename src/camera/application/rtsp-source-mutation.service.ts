import { Inject, Injectable } from '@nestjs/common';
import { CameraSourceUnavailableError } from '../domain/errors/camera-source-unavailable.error';
import { LiveSourceCredentialUnavailableError } from '../domain/errors/live-source-credential-unavailable.error';
import { LiveSourceStateChangedError } from '../domain/errors/live-source-state-changed.error';
import { LiveStreamUnavailableError } from '../domain/errors/live-stream-unavailable.error';
import {
  LiveSource,
  type LiveSourceProfileSettings,
  type LiveSourceSecuritySettings,
  type LiveSourceTransportSettings,
} from '../domain/live-source.entity';
import { CAMERA_CLOCK, type CameraClockPort } from '../domain/ports/camera-clock.port';
import {
  CAMERA_SOURCE_AUTHORIZATION,
  type CameraSourceAuthorizationPort,
} from '../domain/ports/camera-source-authorization.port';
import {
  LIVE_SOURCE_CREDENTIAL,
  type LiveSourceCredentialPort,
} from '../domain/ports/live-source-credential.port';
import {
  LIVE_SOURCE_PROBE,
  type LiveSourceProbePort,
} from '../domain/ports/live-source-probe.port';
import {
  LIVE_SOURCE_REPOSITORY,
  type LiveSourceRepositoryPort,
  type RedactedLiveSource,
} from '../domain/ports/live-source-repository.port';
import {
  LIVE_SOURCE_SESSION_CONTROL,
  type LiveSourceSessionControlPort,
} from '../domain/ports/live-source-session-control.port';
import type { PersistVerifiedSource } from '../domain/ports/rtsp-source-configuration.port';
import { RtspPolicyDigestMismatchError } from '../../features/domain/errors/rtsp-policy-digest-mismatch.error';
import {
  FEATURE_AVAILABILITY,
  type FeatureAvailabilityPort,
} from '../../features/domain/ports/feature-availability.port';
import {
  RTSP_POLICY_STATUS,
  type RtspPolicyStatusPort,
} from '../../features/domain/ports/rtsp-policy-status.port';
import { RtspSourceStartGate } from './rtsp-source-start-gate.service';

/** The endpoint half of every source mutation, before it is bound to a camera. */
export interface RtspSourceInput {
  actorUserId: number;
  url: string;
  transport: LiveSourceTransportSettings['transport'];
  tlsMode: LiveSourceSecuritySettings['tlsMode'];
  profile: LiveSourceProfileSettings['profile'];
  substream?: string | null;
}

/** A source that installs a credential: create, attach, replace. */
interface InstallPlan {
  actorUserId: number;
  cameraId: string;
  source: LiveSource;
  /** Revision the caller committed to, or `null` when nothing is stored yet. */
  expectedRevision: number | null;
  /** Replacement takes the camera off air before the swap; first writes do not. */
  stopSessions: boolean;
}

interface RetirePlan {
  actorUserId: number;
  cameraId: string;
  expectedRevision: number;
}

/**
 * The orchestration every RTSP source mutation shares, so the ordering that
 * makes those mutations safe is written once.
 *
 * Each flow captures the policy digest, the start-gate epoch and the stored
 * revision before it probes, and re-checks all of them — plus the actor's role —
 * immediately before handing a finished, encrypted result to the synchronous
 * configuration transaction. The final checks and the commit share one
 * uninterruptible turn: the operation classes supply `commit` as a synchronous
 * callback precisely so no `await` can be introduced between them.
 *
 * Plaintext lives only in the `LiveSource` this service probes and encrypts;
 * nothing it returns or throws carries a URL.
 */
@Injectable()
export class RtspSourceMutationService {
  constructor(
    @Inject(CAMERA_SOURCE_AUTHORIZATION)
    private readonly authorization: CameraSourceAuthorizationPort,
    @Inject(FEATURE_AVAILABILITY)
    private readonly availability: FeatureAvailabilityPort,
    @Inject(RTSP_POLICY_STATUS)
    private readonly policyStatus: RtspPolicyStatusPort,
    @Inject(LIVE_SOURCE_PROBE) private readonly probe: LiveSourceProbePort,
    @Inject(LIVE_SOURCE_CREDENTIAL)
    private readonly credentials: LiveSourceCredentialPort,
    @Inject(LIVE_SOURCE_SESSION_CONTROL)
    private readonly sessions: LiveSourceSessionControlPort,
    @Inject(LIVE_SOURCE_REPOSITORY)
    private readonly repository: LiveSourceRepositoryPort,
    @Inject(CAMERA_CLOCK) private readonly clock: CameraClockPort,
    private readonly gate: RtspSourceStartGate,
  ) {}

  /**
   * The first fence, for work an operation must do before it can describe the
   * mutation at all — minting an identifier, or validating a display name.
   */
  requireAdmin(actorUserId: number): void {
    this.authorization.requireAdmin(actorUserId);
  }

  /** Verifies a source end to end, then commits it in one synchronous turn. */
  async install<T>(
    plan: InstallPlan,
    commit: (verified: PersistVerifiedSource) => T,
  ): Promise<T> {
    this.authorization.requireAdmin(plan.actorUserId);
    await this.availability.requireReady('rtsp');
    const policy = await this.policyStatus.requireCurrent();
    const epoch = this.gate.snapshot();
    await this.requireStoredRevision(plan.cameraId, plan.expectedRevision);
    await this.probe.run(plan.source);
    const credential = this.credentials.encrypt(
      plan.source.cameraId,
      plan.source.credentialPayload(),
    );
    if (plan.stopSessions) await this.stopCamera(plan.cameraId);
    await this.availability.requireReady('rtsp');
    const current = await this.policyStatus.requireCurrent();

    // FENCE: no await below this line. Everything from here to the synchronous
    // configuration transaction runs in one uninterruptible turn.
    this.authorization.requireAdmin(plan.actorUserId);
    this.assertGateOpen(epoch);
    this.policyStatus.assertDigest(policy.digest);
    this.assertSameDigest(current.digest, policy.digest);
    return commit({
      source: plan.source,
      credential,
      policyDigest: policy.digest,
      verifiedAt: this.clock.now(),
    });
  }

  /** The same fences for a retirement, which probes and encrypts nothing. */
  async retire<T>(plan: RetirePlan, commit: () => T): Promise<T> {
    this.authorization.requireAdmin(plan.actorUserId);
    await this.availability.requireReady('rtsp');
    const policy = await this.policyStatus.requireCurrent();
    const epoch = this.gate.snapshot();
    await this.requireStoredRevision(plan.cameraId, plan.expectedRevision);
    await this.stopCamera(plan.cameraId);
    await this.availability.requireReady('rtsp');
    const current = await this.policyStatus.requireCurrent();

    // FENCE: no await below this line. Everything from here to the synchronous
    // configuration transaction runs in one uninterruptible turn.
    this.authorization.requireAdmin(plan.actorUserId);
    this.assertGateOpen(epoch);
    this.policyStatus.assertDigest(policy.digest);
    this.assertSameDigest(current.digest, policy.digest);
    return commit();
  }

  /**
   * Re-probes a stored source. Writes nothing: the revision, attestation,
   * readiness, credential and timestamps a caller reads back are the ones
   * already on disk, so a failed test never demotes a working camera.
   */
  async verifyStored(input: {
    actorUserId: number;
    cameraId: string;
  }): Promise<RedactedLiveSource> {
    this.authorization.requireAdmin(input.actorUserId);
    await this.availability.requireReady('rtsp');
    await this.policyStatus.requireCurrent();
    const stored = await this.repository.findRedacted(input.cameraId);
    if (!stored) throw new LiveSourceStateChangedError();
    const loaded = await this.repository.loadForStream(input.cameraId);
    if (!loaded) throw new LiveSourceCredentialUnavailableError();
    await this.probe.run(loaded.source);
    return stored;
  }

  /** Fails fast when the stored revision already disagrees with the caller. */
  private async requireStoredRevision(
    cameraId: string,
    expected: number | null,
  ): Promise<void> {
    const stored = await this.repository.findRedacted(cameraId);
    if ((stored?.revision ?? null) !== expected) {
      throw new LiveSourceStateChangedError();
    }
  }

  /** A stop failure is a mutation failure, never a "live stream unavailable". */
  private async stopCamera(cameraId: string): Promise<void> {
    try {
      await this.sessions.stopCamera(cameraId);
    } catch {
      throw new CameraSourceUnavailableError('session-stop-failed');
    }
  }

  private assertGateOpen(epoch: number): void {
    try {
      this.gate.assertEpoch(epoch);
    } catch (error) {
      if (error instanceof LiveStreamUnavailableError) {
        throw new CameraSourceUnavailableError('rtsp-closed');
      }
      throw error;
    }
  }

  private assertSameDigest(current: string, captured: string): void {
    if (current !== captured) throw new RtspPolicyDigestMismatchError(captured);
  }
}

/** Builds the probe-ready source every mutation shares, credentials included. */
export function liveSourceFrom(cameraId: string, input: RtspSourceInput): LiveSource {
  return LiveSource.create({
    cameraId,
    url: input.url,
    transport: input.transport,
    tlsMode: input.tlsMode,
    profile: input.profile,
    substream: input.substream,
    ready: true,
  });
}

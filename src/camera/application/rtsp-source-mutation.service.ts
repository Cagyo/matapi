import { Inject, Injectable } from '@nestjs/common';
import { CameraSourceUnavailableError } from '../domain/errors/camera-source-unavailable.error';
import { InvalidLiveSourceError } from '../domain/errors/invalid-live-source.error';
import { LiveSourceCredentialUnavailableError } from '../domain/errors/live-source-credential-unavailable.error';
import { LiveSourceStateChangedError } from '../domain/errors/live-source-state-changed.error';
import { LiveStreamUnavailableError } from '../domain/errors/live-stream-unavailable.error';
import type { LiveSourceEndpointInput } from '../domain/live-source-factory';
import type { LiveSource } from '../domain/live-source.entity';
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

/** The endpoint half of every source mutation, plus the actor performing it. */
export interface RtspSourceInput extends LiveSourceEndpointInput {
  actorUserId: number;
}

/**
 * A commit callback the fence can trust. `then?: never` makes an `async`
 * callback fail to compile: an operation class that returned a promise here
 * would reopen the async boundary the whole fence exists to close, and the
 * source-text test alone could not see it from another file.
 */
type SyncCommit<T> = T & { then?: never };

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
 * An **install** flow — create, attach, replace — captures the policy digest,
 * the start-gate epoch and the stored revision before it probes, and re-checks
 * all of them, plus the actor's role, immediately before handing a finished,
 * encrypted result to the synchronous configuration transaction. A **retire**
 * flow carries far fewer fences on purpose; see `retire`.
 *
 * The final checks and the commit share one uninterruptible turn: the operation
 * classes supply `commit` as a synchronous callback precisely so no `await` can
 * be introduced between them.
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
   * mutation at all — minting an identifier, or resolving a display name.
   */
  requireAdmin(actorUserId: number): void {
    this.authorization.requireAdmin(actorUserId);
  }

  /** Verifies a source end to end, then commits it in one synchronous turn. */
  async install<T>(
    plan: InstallPlan,
    commit: (verified: PersistVerifiedSource) => SyncCommit<T>,
  ): Promise<T> {
    // This service owns the identity invariant rather than leaving it to the
    // adapter: fencing the revision and the session against one camera while
    // encrypting for another would validate the wrong camera entirely.
    if (plan.source.cameraId !== plan.cameraId) {
      throw new InvalidLiveSourceError('source addresses another camera');
    }
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
    await this.availability.requireReady('rtsp');
    const current = await this.policyStatus.requireCurrent();
    // Last of the awaits, deliberately: an `await` between the stop and the
    // commit is a window in which a user-initiated `OpenLiveStreamUseCase` can
    // start a converter for this camera. That start moves no gate epoch, so no
    // fence below would see it, and the swap would land while a converter still
    // streamed the old URL.
    if (plan.stopSessions) await this.stopCamera(plan.cameraId);

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

  /**
   * Retires a source. Deliberately far less fenced than `install`.
   *
   * Removal probes nothing, encrypts nothing and persists no digest — Task 5's
   * `remove({ cameraId, expectedRevision })` signature says as much — and the
   * policy installer never touches `cameras` or `camera_live_sources`. Gating
   * removal on RTSP readiness and a current policy therefore protects nothing,
   * while creating an indefinite lock-out: on a network where the inspector
   * finds no eligible interface the reinstall can never complete, so the admin
   * could never remove the source. A policy that goes stale mid-run is the
   * common case — the stored ready flag is untouched, so `requireReady` passes
   * and only `requireCurrent` would block. `assertGateOpen` is dropped for the
   * same reason and one more: nothing replays sessions when the gate reopens,
   * so there is no restart for the epoch fence to protect against.
   *
   * What remains is what actually makes a removal safe: the compare-and-swap,
   * and authorization on both sides of the stop, because `stopCamera` awaits and
   * an actor demoted in that window must not complete a destructive write.
   *
   * The stop stays fenced by choice, not oversight. A converter wedged in
   * `cleanupBlocked` whose `retryBlockedCleanup()` keeps failing refuses removal
   * with `session-stop-failed` after a 30 s wait, indefinitely. That lock-out
   * needs a wedged FFmpeg rather than a merely hostile network, and deleting the
   * row out from under a converter that is still streaming it is worse.
   */
  async retire<T>(plan: RetirePlan, commit: () => SyncCommit<T>): Promise<T> {
    this.authorization.requireAdmin(plan.actorUserId);
    await this.requireStoredRevision(plan.cameraId, plan.expectedRevision);
    await this.stopCamera(plan.cameraId);

    // FENCE: no await below this line. Everything from here to the synchronous
    // configuration transaction runs in one uninterruptible turn.
    this.authorization.requireAdmin(plan.actorUserId);
    return commit();
  }

  /**
   * Re-probes a stored source. Writes nothing: the revision, attestation,
   * readiness, credential and timestamps a caller reads back are the ones
   * already on disk, so a failed test never demotes a working camera.
   *
   * Fully gated, unlike `retire`: this runs a real probe, and probe egress is
   * exactly what the RTSP network policy governs.
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

import type { LiveSource } from '../live-source.entity';
import type { EncryptedLiveSourceCredential } from './live-source-credential.port';
import type { RedactedLiveSource } from './live-source-repository.port';

export const RTSP_SOURCE_CONFIGURATION = Symbol('RTSP_SOURCE_CONFIGURATION');

/**
 * `cameras.type` of a row this port created, which therefore exists only to
 * carry a source and is removed with it. Deliberately not `'rtsp'`: that word
 * already names a camera *backend* in `sensors/infrastructure/camera.config.ts`
 * and `config/dev-state.yml` ships a hand-written `type: rtsp` camera, so
 * reusing it would let `remove()` delete an operator's camera outright. Both
 * adapters read this one constant — it is the removal semantics.
 */
export const RTSP_SOURCE_CAMERA_TYPE = 'rtsp-source';

/**
 * One probe-verified source plus the attestation that goes with it. The
 * credential is already ciphertext: the port neither encrypts nor reads it.
 */
export interface PersistVerifiedSource {
  source: LiveSource;
  credential: EncryptedLiveSourceCredential;
  /** Digest of the RTSP network policy in force when the probe passed. */
  policyDigest: string;
  /** When the probe passed. Stored as epoch milliseconds. */
  verifiedAt: Date;
}

/**
 * Every camera-source mutation, each as one synchronous transaction.
 *
 * Synchronous on purpose: authorization, gate epoch, and policy digest are
 * rechecked immediately before the swap, and no `await` may sit between those
 * checks and the write. better-sqlite3 transactions are synchronous, so the
 * whole commit fits in one uninterruptible turn. Do not make any method
 * `async` or have it return a promise.
 *
 * The adapter performs no encryption, probing, DNS, or authorization; callers
 * do that first and hand over the finished result.
 */
export interface RtspSourceConfigurationPort {
  /**
   * Stores a new `RTSP_SOURCE_CAMERA_TYPE` camera together with its source and
   * credential. `camera.nameKey` must be the canonical key of `camera.name`,
   * and `source.cameraId` must be `camera.id`.
   *
   * @throws InvalidLiveSourceError when either of those two does not hold.
   * @throws CameraIdCollisionError when the identifier is already stored.
   * @throws CameraNameTakenError when the canonical name is already claimed —
   * including by a legacy row the name-key backfill has not claimed yet, which
   * the transaction canonicalizes itself.
   */
  createCamera(
    input: PersistVerifiedSource & {
      camera: { id: string; name: string; nameKey: string };
    },
  ): RedactedLiveSource;
  /**
   * Gives an existing camera its first source. The source primary key is the
   * attach/attach concurrency authority, and the camera's `enabled` flag is
   * re-read inside the same transaction.
   *
   * @throws InvalidLiveSourceError when the source addresses another camera.
   * @throws LiveSourceStateChangedError when the camera already has a source,
   * has been disabled, or no longer exists.
   */
  attach(input: PersistVerifiedSource & { cameraId: string }): RedactedLiveSource;
  /**
   * Swaps a stored source, advancing the revision to `expectedRevision + 1`.
   *
   * @throws InvalidLiveSourceError when the source addresses another camera.
   * @throws LiveSourceStateChangedError when the stored revision moved.
   */
  replace(
    input: PersistVerifiedSource & { cameraId: string; expectedRevision: number },
  ): RedactedLiveSource;
  /**
   * Retires a source. The transaction reads the stored camera type itself and
   * deletes the whole camera only for `RTSP_SOURCE_CAMERA_TYPE` rows, which
   * exist solely to carry a source; a camera that predates its source is kept,
   * and so is its recorded media, which is de-attributed rather than deleted.
   * Callers do not get to decide which happens.
   *
   * @throws LiveSourceStateChangedError when the stored revision moved.
   */
  remove(input: { cameraId: string; expectedRevision: number }): {
    removed: 'camera' | 'source';
  };
}

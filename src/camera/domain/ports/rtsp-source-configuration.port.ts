import type { LiveSource } from '../live-source.entity';
import type { EncryptedLiveSourceCredential } from './live-source-credential.port';
import type { RedactedLiveSource } from './live-source-repository.port';

export const RTSP_SOURCE_CONFIGURATION = Symbol('RTSP_SOURCE_CONFIGURATION');

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
   * Stores a new `rtsp` camera together with its source and credential.
   * `camera.nameKey` must be the canonical key of `camera.name`, and
   * `source.cameraId` must be `camera.id`.
   *
   * @throws CameraIdCollisionError when the identifier is already stored.
   * @throws CameraNameTakenError when the canonical name is already claimed.
   */
  createCamera(
    input: PersistVerifiedSource & {
      camera: { id: string; name: string; nameKey: string };
    },
  ): RedactedLiveSource;
  /**
   * Gives an existing camera its first source. The source primary key is the
   * attach/attach concurrency authority.
   *
   * @throws LiveSourceStateChangedError when the camera already has a source or
   * no longer exists.
   */
  attach(input: PersistVerifiedSource & { cameraId: string }): RedactedLiveSource;
  /**
   * Swaps a stored source, advancing the revision to `expectedRevision + 1`.
   *
   * @throws LiveSourceStateChangedError when the stored revision moved.
   */
  replace(
    input: PersistVerifiedSource & { cameraId: string; expectedRevision: number },
  ): RedactedLiveSource;
  /**
   * Retires a source. The transaction reads the stored camera type itself and
   * deletes the whole camera only for `type: 'rtsp'` rows, which exist solely
   * to carry a source; a camera that predates its source is kept. Callers do
   * not get to decide which happens.
   *
   * @throws LiveSourceStateChangedError when the stored revision moved.
   */
  remove(input: { cameraId: string; expectedRevision: number }): {
    removed: 'camera' | 'source';
  };
}

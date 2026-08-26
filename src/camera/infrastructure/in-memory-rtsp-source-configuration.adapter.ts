import { cameraNameKey } from '../domain/camera-name-key';
import type { LiveSource, LiveSourceSummary } from '../domain/live-source.entity';
import { CameraIdCollisionError } from '../domain/errors/camera-id-collision.error';
import { CameraNameTakenError } from '../domain/errors/camera-name-taken.error';
import { InvalidLiveSourceError } from '../domain/errors/invalid-live-source.error';
import { LiveSourceStateChangedError } from '../domain/errors/live-source-state-changed.error';
import type { EncryptedLiveSourceCredential } from '../domain/ports/live-source-credential.port';
import type { RedactedLiveSource } from '../domain/ports/live-source-repository.port';
import type {
  PersistVerifiedSource,
  RtspSourceConfigurationPort,
} from '../domain/ports/rtsp-source-configuration.port';

/** Mirrors `cameras`; see the Drizzle adapter for the authoritative semantics. */
export interface InMemoryCameraRow {
  id: string;
  name: string;
  nameKey: string;
  type: string;
}

/** Credential-free view of a stored source, for assertions and dev listings. */
export interface InMemorySourceRow {
  cameraId: string;
  summary: LiveSourceSummary;
  revision: number;
  verifiedAt: Date;
  policyDigest: string;
  hasCredential: boolean;
}

const RTSP_CAMERA_TYPE = 'rtsp';

interface StoredSource {
  source: LiveSource;
  credential: EncryptedLiveSourceCredential;
  revision: number;
  verifiedAt: Date;
  policyDigest: string;
}

/**
 * In-process stand-in for tests and stub composition. Each method validates
 * everything before touching either map, so a rejected call leaves no partial
 * state — the counterpart of the Drizzle adapter's single transaction.
 */
export class InMemoryRtspSourceConfigurationAdapter
  implements RtspSourceConfigurationPort
{
  readonly #cameras = new Map<string, InMemoryCameraRow>();
  readonly #sources = new Map<string, StoredSource>();

  /** Seeds a camera that predates any RTSP source, as `attach` expects. */
  seedCamera(camera: { id: string; name: string; type: string }): void {
    const nameKey = cameraNameKey(camera.name);
    if (this.#cameras.has(camera.id)) throw new CameraIdCollisionError();
    if (this.#nameKeyTaken(nameKey)) throw new CameraNameTakenError();
    this.#cameras.set(camera.id, { ...camera, nameKey });
  }

  cameras(): InMemoryCameraRow[] {
    return [...this.#cameras.values()].map((camera) => ({ ...camera }));
  }

  sources(): InMemorySourceRow[] {
    return [...this.#sources.entries()].map(([cameraId, stored]) => ({
      cameraId,
      summary: stored.source.summary(),
      revision: stored.revision,
      verifiedAt: stored.verifiedAt,
      policyDigest: stored.policyDigest,
      hasCredential: true,
    }));
  }

  createCamera(
    input: PersistVerifiedSource & {
      camera: { id: string; name: string; nameKey: string };
    },
  ): RedactedLiveSource {
    const { camera } = input;
    assertSourceAddresses(input.source, camera.id);
    if (camera.nameKey !== cameraNameKey(camera.name)) {
      throw new InvalidLiveSourceError('camera name key is not canonical');
    }
    if (this.#cameras.has(camera.id)) throw new CameraIdCollisionError();
    if (this.#nameKeyTaken(camera.nameKey)) throw new CameraNameTakenError();

    this.#cameras.set(camera.id, {
      id: camera.id,
      name: camera.name,
      nameKey: camera.nameKey,
      type: RTSP_CAMERA_TYPE,
    });
    this.#sources.set(camera.id, storedFrom(input, 0));
    return redacted(input, camera.name, 0);
  }

  attach(input: PersistVerifiedSource & { cameraId: string }): RedactedLiveSource {
    assertSourceAddresses(input.source, input.cameraId);
    const camera = this.#cameras.get(input.cameraId);
    if (!camera) throw new LiveSourceStateChangedError();
    if (this.#sources.has(input.cameraId)) throw new LiveSourceStateChangedError();

    this.#sources.set(input.cameraId, storedFrom(input, 0));
    return redacted(input, camera.name, 0);
  }

  replace(
    input: PersistVerifiedSource & { cameraId: string; expectedRevision: number },
  ): RedactedLiveSource {
    assertSourceAddresses(input.source, input.cameraId);
    const camera = this.#cameras.get(input.cameraId);
    const stored = this.#sources.get(input.cameraId);
    if (!camera || stored?.revision !== input.expectedRevision) {
      throw new LiveSourceStateChangedError();
    }
    const revision = input.expectedRevision + 1;

    this.#sources.set(input.cameraId, storedFrom(input, revision));
    return redacted(input, camera.name, revision);
  }

  remove(input: { cameraId: string; expectedRevision: number }): {
    removed: 'camera' | 'source';
  } {
    const camera = this.#cameras.get(input.cameraId);
    const stored = this.#sources.get(input.cameraId);
    if (!camera || stored?.revision !== input.expectedRevision) {
      throw new LiveSourceStateChangedError();
    }

    this.#sources.delete(input.cameraId);
    // The stored type decides, exactly as the SQL removal does.
    if (camera.type !== RTSP_CAMERA_TYPE) return { removed: 'source' };
    this.#cameras.delete(input.cameraId);
    return { removed: 'camera' };
  }

  #nameKeyTaken(nameKey: string): boolean {
    return [...this.#cameras.values()].some((camera) => camera.nameKey === nameKey);
  }
}

function storedFrom(input: PersistVerifiedSource, revision: number): StoredSource {
  return {
    source: input.source,
    credential: { ...input.credential },
    revision,
    verifiedAt: new Date(input.verifiedAt.getTime()),
    policyDigest: input.policyDigest,
  };
}

function redacted(
  input: PersistVerifiedSource,
  cameraName: string,
  revision: number,
): RedactedLiveSource {
  return {
    cameraId: input.source.cameraId,
    cameraName,
    summary: input.source.summary(),
    hasCredential: true,
    revision,
    verifiedAt: new Date(input.verifiedAt.getTime()),
    policyDigest: input.policyDigest,
  };
}

function assertSourceAddresses(source: LiveSource, cameraId: string): void {
  if (source.cameraId !== cameraId) {
    throw new InvalidLiveSourceError('source is addressed to a different camera');
  }
}

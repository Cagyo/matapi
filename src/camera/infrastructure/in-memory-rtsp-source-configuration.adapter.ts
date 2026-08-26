import { cameraNameKey } from '../domain/camera-name-key';
import type { LiveSource, LiveSourceSummary } from '../domain/live-source.entity';
import { CameraIdCollisionError } from '../domain/errors/camera-id-collision.error';
import { CameraNameTakenError } from '../domain/errors/camera-name-taken.error';
import { InvalidLiveSourceError } from '../domain/errors/invalid-live-source.error';
import { LiveSourceStateChangedError } from '../domain/errors/live-source-state-changed.error';
import type { EncryptedLiveSourceCredential } from '../domain/ports/live-source-credential.port';
import type { RedactedLiveSource } from '../domain/ports/live-source-repository.port';
import {
  RTSP_SOURCE_CAMERA_TYPE,
  type PersistVerifiedSource,
  type RtspSourceConfigurationPort,
} from '../domain/ports/rtsp-source-configuration.port';

/** Mirrors `cameras`; see the Drizzle adapter for the authoritative semantics. */
export interface InMemoryCameraRow {
  id: string;
  name: string;
  nameKey: string;
  type: string;
  enabled: boolean;
}

/** Credential-free view of a stored source, for assertions and dev listings. */
export interface InMemorySourceRow {
  cameraId: string;
  summary: LiveSourceSummary;
  revision: number;
  verifiedAt: Date | null;
  policyDigest: string | null;
  hasCredential: boolean;
}

export interface InMemoryVerifiedSourceWrite {
  source: LiveSource;
  cameraName: string;
  credential: EncryptedLiveSourceCredential;
  revision: number;
  verifiedAt: Date;
  policyDigest: string;
}

/**
 * The slice of stub camera state this port shares with the in-memory media
 * repository, so a camera created here is visible to `listCameras()`,
 * `findCameraByName()` and every status command — and so name uniqueness is
 * decided against the rows the rest of the app can actually see.
 *
 * Synchronous by necessity: the port may not open an async boundary.
 */
export interface InMemoryCameraStore {
  /** Every stored camera, enabled or not. */
  allCameras(): readonly InMemoryCameraRow[];
  addCamera(camera: InMemoryCameraRow): void;
  /** Also de-attributes recorded media, mirroring the SQL removal. */
  removeCamera(cameraId: string): void;
}

/** The same arrangement for the in-memory live-source repository. */
export interface InMemoryLiveSourceStore {
  listStoredSources(): readonly InMemorySourceRow[];
  /** Compare-and-swap read; `null` when the camera has no source. */
  storedRevision(cameraId: string): number | null;
  putVerifiedSource(input: InMemoryVerifiedSourceWrite): void;
  dropSource(cameraId: string): void;
}

/**
 * In-process stand-in for tests and stub composition. Each method validates
 * everything before touching either store, so a rejected call leaves no partial
 * state — the counterpart of the Drizzle adapter's single transaction.
 *
 * Constructed bare it owns private stores, which is what a focused unit test
 * wants. Stub composition passes the real in-memory repositories instead, so
 * the twin and the rest of the app agree on one set of rows.
 */
export class InMemoryRtspSourceConfigurationAdapter
  implements RtspSourceConfigurationPort
{
  constructor(
    private readonly cameraStore: InMemoryCameraStore = new StandaloneCameraStore(),
    private readonly sourceStore: InMemoryLiveSourceStore = new StandaloneLiveSourceStore(),
  ) {}

  /** Seeds a camera that predates any RTSP source, as `attach` expects. */
  seedCamera(camera: {
    id: string;
    name: string;
    type: string;
    enabled?: boolean;
  }): void {
    const nameKey = cameraNameKey(camera.name);
    if (this.#camera(camera.id)) throw new CameraIdCollisionError();
    if (this.#nameKeyTaken(nameKey)) throw new CameraNameTakenError();
    this.cameraStore.addCamera({
      id: camera.id,
      name: camera.name,
      nameKey,
      type: camera.type,
      enabled: camera.enabled ?? true,
    });
  }

  cameras(): InMemoryCameraRow[] {
    return this.cameraStore.allCameras().map((camera) => ({ ...camera }));
  }

  sources(): InMemorySourceRow[] {
    return this.sourceStore.listStoredSources().map((row) => ({ ...row }));
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
    if (this.#camera(camera.id)) throw new CameraIdCollisionError();
    if (this.#nameKeyTaken(camera.nameKey)) throw new CameraNameTakenError();

    this.cameraStore.addCamera({
      id: camera.id,
      name: camera.name,
      nameKey: camera.nameKey,
      type: RTSP_SOURCE_CAMERA_TYPE,
      enabled: true,
    });
    this.sourceStore.putVerifiedSource(written(input, camera.name, 0));
    return redacted(input, camera.name, 0);
  }

  attach(input: PersistVerifiedSource & { cameraId: string }): RedactedLiveSource {
    assertSourceAddresses(input.source, input.cameraId);
    const camera = this.#camera(input.cameraId);
    // Disabled is a state change, exactly as it is inside the SQL transaction.
    if (!camera?.enabled) throw new LiveSourceStateChangedError();
    if (this.sourceStore.storedRevision(input.cameraId) !== null) {
      throw new LiveSourceStateChangedError();
    }

    this.sourceStore.putVerifiedSource(written(input, camera.name, 0));
    return redacted(input, camera.name, 0);
  }

  replace(
    input: PersistVerifiedSource & { cameraId: string; expectedRevision: number },
  ): RedactedLiveSource {
    assertSourceAddresses(input.source, input.cameraId);
    const camera = this.#camera(input.cameraId);
    const stored = this.sourceStore.storedRevision(input.cameraId);
    if (!camera || stored !== input.expectedRevision) {
      throw new LiveSourceStateChangedError();
    }
    const revision = input.expectedRevision + 1;

    this.sourceStore.putVerifiedSource(written(input, camera.name, revision));
    return redacted(input, camera.name, revision);
  }

  remove(input: { cameraId: string; expectedRevision: number }): {
    removed: 'camera' | 'source';
  } {
    const camera = this.#camera(input.cameraId);
    const stored = this.sourceStore.storedRevision(input.cameraId);
    if (!camera || stored !== input.expectedRevision) {
      throw new LiveSourceStateChangedError();
    }

    this.sourceStore.dropSource(input.cameraId);
    // The stored type decides, exactly as the SQL removal does.
    if (camera.type !== RTSP_SOURCE_CAMERA_TYPE) return { removed: 'source' };
    this.cameraStore.removeCamera(input.cameraId);
    return { removed: 'camera' };
  }

  #camera(cameraId: string): InMemoryCameraRow | undefined {
    return this.cameraStore.allCameras().find((camera) => camera.id === cameraId);
  }

  #nameKeyTaken(nameKey: string): boolean {
    return this.cameraStore
      .allCameras()
      .some((camera) => camera.nameKey === nameKey);
  }
}

/** Private camera rows for an adapter constructed without a shared store. */
class StandaloneCameraStore implements InMemoryCameraStore {
  readonly #cameras = new Map<string, InMemoryCameraRow>();

  allCameras(): readonly InMemoryCameraRow[] {
    return [...this.#cameras.values()];
  }

  addCamera(camera: InMemoryCameraRow): void {
    this.#cameras.set(camera.id, { ...camera });
  }

  removeCamera(cameraId: string): void {
    this.#cameras.delete(cameraId);
  }
}

/**
 * Private source rows for the same case. The `LiveSource` entity is
 * deliberately not retained — it carries the plaintext URL in its credential
 * payload, which has no business sitting in a long-lived map this port owns —
 * so only its credential-free projection is kept.
 *
 * The ciphertext credential *is* retained, mirroring what the live-source
 * repository holds, so `hasCredential` is derived from what was actually
 * written rather than assumed from the fact that this port always writes one.
 *
 * One state this store cannot reach: the shared repository's map is also
 * written by `save`/`saveMetadataBatch`, so a camera there can already hold an
 * imported, credential-free source before this port is ever called — which is
 * what SQLite does too. Tests that depend on that pre-state must use the
 * shared-store wiring, not this one.
 */
class StandaloneLiveSourceStore implements InMemoryLiveSourceStore {
  readonly #sources = new Map<
    string,
    Omit<InMemorySourceRow, 'hasCredential'> & {
      credential: EncryptedLiveSourceCredential | null;
    }
  >();

  listStoredSources(): readonly InMemorySourceRow[] {
    return [...this.#sources.values()].map(({ credential, ...row }) => ({
      ...row,
      hasCredential: credential !== null,
    }));
  }

  storedRevision(cameraId: string): number | null {
    return this.#sources.get(cameraId)?.revision ?? null;
  }

  putVerifiedSource(input: InMemoryVerifiedSourceWrite): void {
    this.#sources.set(input.source.cameraId, {
      cameraId: input.source.cameraId,
      summary: input.source.summary(),
      revision: input.revision,
      verifiedAt: new Date(input.verifiedAt.getTime()),
      policyDigest: input.policyDigest,
      credential: { ...input.credential },
    });
  }

  dropSource(cameraId: string): void {
    this.#sources.delete(cameraId);
  }
}

function written(
  input: PersistVerifiedSource,
  cameraName: string,
  revision: number,
): InMemoryVerifiedSourceWrite {
  return {
    source: input.source,
    cameraName,
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

import type { LiveSource } from '../domain/live-source.entity';
import { InvalidLiveSourceError } from '../domain/errors/invalid-live-source.error';
import { LiveSourceCredentialUnavailableError } from '../domain/errors/live-source-credential-unavailable.error';
import type { LiveSourceCredentialPort } from '../domain/ports/live-source-credential.port';
import type {
  EncryptedLiveSourceCredential,
  LiveSourceForStream,
  LiveSourceRepositoryPort,
  RedactedLiveSource,
} from '../domain/ports/live-source-repository.port';
import type {
  InMemoryLiveSourceStore,
  InMemorySourceRow,
  InMemoryVerifiedSourceWrite,
} from './in-memory-rtsp-source-configuration.adapter';

interface StoredLiveSource {
  source: LiveSource;
  credential: EncryptedLiveSourceCredential | null;
  cameraName: string;
  /**
   * Mirrors the columns the source-configuration transaction owns. Nothing here
   * grants a verification, so a source saved through this adapter stays at
   * revision 0 and unverified — and a save clears any attestation it inherits,
   * because it may have replaced the URL that attestation described.
   */
  revision: number;
  verifiedAt: Date | null;
  policyDigest: string | null;
}

/**
 * Also serves the synchronous source store the RTSP source-configuration twin
 * writes through, so a source configured in stub mode is visible to
 * `listRedacted()` and `loadForStream()` like any other.
 */
export class InMemoryLiveSourceRepository
  implements LiveSourceRepositoryPort, InMemoryLiveSourceStore
{
  readonly #sources = new Map<string, StoredLiveSource>();
  #credentialWritesEnabled = false;

  constructor(
    private readonly credentials: LiveSourceCredentialPort,
    private readonly cameraNameForId: (cameraId: string) => Promise<string> =
      async (cameraId) => cameraId,
  ) {}

  async save(
    source: LiveSource,
    credential: EncryptedLiveSourceCredential | null,
  ): Promise<void> {
    if (credential && !this.#credentialWritesEnabled) {
      throw new LiveSourceCredentialUnavailableError();
    }
    const previous = this.#sources.get(source.cameraId);
    this.#sources.set(source.cameraId, {
      source,
      credential: credential ? { ...credential } : null,
      cameraName: source.cameraId,
      revision: previous?.revision ?? 0,
      verifiedAt: null,
      policyDigest: null,
    });
  }

  async loadForStream(cameraId: string): Promise<LiveSourceForStream | null> {
    const stored = this.#sources.get(cameraId);
    if (!stored?.credential || !stored.source.ready) return null;
    return {
      source: stored.source,
      credential: this.credentials.decrypt(cameraId, stored.credential),
    };
  }

  async isReady(cameraId: string): Promise<boolean> {
    const stored = this.#sources.get(cameraId);
    return Boolean(stored?.source.ready && stored.credential);
  }

  async saveMetadataBatch(sources: readonly LiveSource[]): Promise<void> {
    const replacements = new Map(this.#sources);
    for (const source of sources) {
      if (source.ready) {
        throw new InvalidLiveSourceError('metadata import source must not be ready');
      }
      const previous = this.#sources.get(source.cameraId);
      replacements.set(source.cameraId, {
        source,
        credential: null,
        cameraName: source.cameraId,
        revision: previous?.revision ?? 0,
        verifiedAt: null,
        policyDigest: null,
      });
    }
    this.#sources.clear();
    for (const [cameraId, stored] of replacements) this.#sources.set(cameraId, stored);
  }

  async findRedacted(cameraId: string): Promise<RedactedLiveSource | null> {
    const stored = this.#sources.get(cameraId);
    return stored ? this.#redact(stored) : null;
  }

  async listRedacted(): Promise<RedactedLiveSource[]> {
    return Promise.all([...this.#sources.values()].map((stored) => this.#redact(stored)));
  }

  async #redact(stored: StoredLiveSource): Promise<RedactedLiveSource> {
    const { source, cameraName, credential } = stored;
    return {
      cameraId: source.cameraId,
      cameraName:
        cameraName === source.cameraId
          ? await this.cameraNameForId(source.cameraId)
          : cameraName,
      summary: source.summary(),
      hasCredential: credential !== null,
      revision: stored.revision,
      verifiedAt: stored.verifiedAt,
      policyDigest: stored.policyDigest,
    };
  }

  /**
   * Synchronous source-store surface (`InMemoryLiveSourceStore`). Unlike
   * `save`, these writes come from the source-configuration transaction, which
   * owns `revision`/`verifiedAt`/`policyDigest` and therefore may set them.
   */
  listStoredSources(): readonly InMemorySourceRow[] {
    return [...this.#sources.values()].map((stored) => ({
      cameraId: stored.source.cameraId,
      summary: stored.source.summary(),
      revision: stored.revision,
      verifiedAt: stored.verifiedAt,
      policyDigest: stored.policyDigest,
      hasCredential: stored.credential !== null,
    }));
  }

  storedRevision(cameraId: string): number | null {
    return this.#sources.get(cameraId)?.revision ?? null;
  }

  putVerifiedSource(input: InMemoryVerifiedSourceWrite): void {
    this.#sources.set(input.source.cameraId, {
      source: input.source,
      credential: { ...input.credential },
      cameraName: input.cameraName,
      revision: input.revision,
      verifiedAt: input.verifiedAt,
      policyDigest: input.policyDigest,
    });
  }

  dropSource(cameraId: string): void {
    this.#sources.delete(cameraId);
  }

  async remove(cameraId: string): Promise<void> {
    this.#sources.delete(cameraId);
  }

  async rotate(): Promise<void> {
    this.#credentialWritesEnabled = false;
    const replacements: [string, EncryptedLiveSourceCredential][] = [];
    for (const [cameraId, stored] of this.#sources) {
      if (!stored.credential) continue;
      const plaintext = this.credentials.decrypt(cameraId, stored.credential);
      if (stored.credential.keyVersion === this.credentials.currentVersion()) continue;
      replacements.push([cameraId, this.credentials.encrypt(cameraId, plaintext)]);
    }
    for (const [cameraId, credential] of replacements) {
      const stored = this.#sources.get(cameraId);
      if (stored) stored.credential = credential;
    }
    this.#credentialWritesEnabled = true;
  }
}

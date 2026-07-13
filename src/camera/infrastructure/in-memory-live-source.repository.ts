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

interface StoredLiveSource {
  source: LiveSource;
  credential: EncryptedLiveSourceCredential | null;
  cameraName: string;
}

export class InMemoryLiveSourceRepository implements LiveSourceRepositoryPort {
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
    this.#sources.set(source.cameraId, {
      source,
      credential: credential ? { ...credential } : null,
      cameraName: source.cameraId,
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

  async saveMetadataBatch(sources: readonly LiveSource[]): Promise<void> {
    const replacements = new Map(this.#sources);
    for (const source of sources) {
      if (source.ready) {
        throw new InvalidLiveSourceError('metadata import source must not be ready');
      }
      replacements.set(source.cameraId, {
        source,
        credential: null,
        cameraName: source.cameraId,
      });
    }
    this.#sources.clear();
    for (const [cameraId, stored] of replacements) this.#sources.set(cameraId, stored);
  }

  async listRedacted(): Promise<RedactedLiveSource[]> {
    return Promise.all(
      [...this.#sources.values()].map(async ({ source, cameraName }) => ({
        cameraId: source.cameraId,
        cameraName:
          cameraName === source.cameraId
            ? await this.cameraNameForId(source.cameraId)
            : cameraName,
        summary: source.summary(),
      })),
    );
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

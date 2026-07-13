import type {
  LiveSource,
  LiveSourceCredentialPayload,
  LiveSourceSummary,
} from '../live-source.entity';
import type { EncryptedLiveSourceCredential } from './live-source-credential.port';

export type { EncryptedLiveSourceCredential } from './live-source-credential.port';

export const LIVE_SOURCE_REPOSITORY = Symbol('LIVE_SOURCE_REPOSITORY');

/** Plaintext exists only across this narrow startup boundary. */
export interface LiveSourceForStream {
  source: LiveSource;
  credential: LiveSourceCredentialPayload;
}

export interface RedactedLiveSource {
  cameraId: string;
  cameraName: string;
  summary: LiveSourceSummary;
}

export interface LiveSourceRepositoryPort {
  /** Null persists not-ready import metadata without a credential row. */
  save(
    source: LiveSource,
    credential: EncryptedLiveSourceCredential | null,
  ): Promise<void>;
  /** Atomically upserts credential-free, not-ready import metadata. */
  saveMetadataBatch(sources: readonly LiveSource[]): Promise<void>;
  loadForStream(cameraId: string): Promise<LiveSourceForStream | null>;
  /** Credential-free readiness lookup for public live-source resolution. */
  isReady(cameraId: string): Promise<boolean>;
  listRedacted(): Promise<RedactedLiveSource[]>;
  remove(cameraId: string): Promise<void>;
  rotate(): Promise<void>;
}

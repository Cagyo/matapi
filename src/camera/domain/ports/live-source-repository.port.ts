import type {
  LiveSource,
  LiveSourceCredentialPayload,
  LiveSourceSummary,
} from '../live-source.entity';

export const LIVE_SOURCE_REPOSITORY = Symbol('LIVE_SOURCE_REPOSITORY');

/** Plaintext exists only across this narrow startup boundary. */
export interface LiveSourceForStream {
  source: LiveSource;
  credential: LiveSourceCredentialPayload;
}

export interface EncryptedLiveSourceCredential {
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: number;
}

export interface RedactedLiveSource {
  cameraId: string;
  summary: LiveSourceSummary;
}

export interface LiveSourceRepositoryPort {
  /** Null persists not-ready import metadata without a credential row. */
  save(
    source: LiveSource,
    credential: EncryptedLiveSourceCredential | null,
  ): Promise<void>;
  loadForStream(cameraId: string): Promise<LiveSourceForStream | null>;
  listRedacted(): Promise<RedactedLiveSource[]>;
  remove(cameraId: string): Promise<void>;
  rotate(): Promise<void>;
}

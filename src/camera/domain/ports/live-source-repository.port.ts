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

/** Outcome of the probe that admitted the stored source, if it was verified. */
export interface LiveSourceVerification {
  verifiedAt: Date;
  /** Digest of the RTSP network policy in force at verification time. */
  policyDigest: string;
}

export interface RedactedLiveSource {
  cameraId: string;
  cameraName: string;
  summary: LiveSourceSummary;
  hasCredential: boolean;
  /** Bumped by every state write; expected by compare-and-swap edits. */
  revision: number;
  verifiedAt: Date | null;
  policyDigest: string | null;
}

export interface LiveSourceRepositoryPort {
  /**
   * Null credential persists not-ready import metadata without a credential
   * row. Writing new state bumps the revision — a first write stores revision
   * 0 — and replaces the verification, so omitting `verification` records the
   * new state as unverified.
   */
  save(
    source: LiveSource,
    credential: EncryptedLiveSourceCredential | null,
    verification?: LiveSourceVerification | null,
  ): Promise<RedactedLiveSource>;
  /** Atomically upserts credential-free, not-ready, unverified import metadata. */
  saveMetadataBatch(sources: readonly LiveSource[]): Promise<void>;
  loadForStream(cameraId: string): Promise<LiveSourceForStream | null>;
  /** Credential-free readiness lookup for public live-source resolution. */
  isReady(cameraId: string): Promise<boolean>;
  listRedacted(): Promise<RedactedLiveSource[]>;
  remove(cameraId: string): Promise<void>;
  rotate(): Promise<void>;
}

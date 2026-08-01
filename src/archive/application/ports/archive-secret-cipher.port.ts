export const ARCHIVE_SECRET_CIPHER = Symbol('ARCHIVE_SECRET_CIPHER');

export type ArchiveSecretKind = 'oauth-client' | 'oauth-token' | 'upload-session';

export interface ArchiveSecretContext {
  installationId: string;
  rowId: string;
  kind: ArchiveSecretKind;
  schemaVersion: number;
}

/** Serializable AES-GCM envelope; the context is authenticated, never stored. */
export interface ArchiveSecretEnvelope {
  version: 1;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export interface ArchiveSecretCipherPort {
  encrypt(plaintext: Buffer, context: ArchiveSecretContext): Promise<ArchiveSecretEnvelope>;
  decrypt(envelope: ArchiveSecretEnvelope, context: ArchiveSecretContext): Promise<Buffer>;
}

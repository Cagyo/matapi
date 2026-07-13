import type { LiveSourceCredentialPayload } from '../live-source.entity';

export const LIVE_SOURCE_CREDENTIAL = Symbol('LIVE_SOURCE_CREDENTIAL');

export interface EncryptedLiveSourceCredential {
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: number;
}

export interface LiveSourceCredentialPort {
  currentVersion(): number;
  encrypt(
    cameraId: string,
    payload: LiveSourceCredentialPayload,
  ): EncryptedLiveSourceCredential;
  decrypt(
    cameraId: string,
    encrypted: EncryptedLiveSourceCredential,
  ): LiveSourceCredentialPayload;
}

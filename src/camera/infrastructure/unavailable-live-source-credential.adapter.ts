import { LiveSourceCredentialUnavailableError } from '../domain/errors/live-source-credential-unavailable.error';
import type { LiveSourceCredentialPayload } from '../domain/live-source.entity';
import type {
  EncryptedLiveSourceCredential,
  LiveSourceCredentialPort,
} from '../domain/ports/live-source-credential.port';

export class UnavailableLiveSourceCredentialAdapter
  implements LiveSourceCredentialPort
{
  currentVersion(): number {
    return 1;
  }

  encrypt(
    _cameraId: string,
    _payload: LiveSourceCredentialPayload,
  ): EncryptedLiveSourceCredential {
    throw new LiveSourceCredentialUnavailableError();
  }

  decrypt(
    _cameraId: string,
    _encrypted: EncryptedLiveSourceCredential,
  ): LiveSourceCredentialPayload {
    throw new LiveSourceCredentialUnavailableError();
  }
}

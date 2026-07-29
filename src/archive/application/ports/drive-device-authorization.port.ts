import type {
  DriveClientCredentials,
  OAuthTokenSet,
} from './drive-credential-repository.port';

export const DRIVE_DEVICE_AUTHORIZATION = Symbol('DRIVE_DEVICE_AUTHORIZATION');

/** Process-memory-only values returned by Google's limited-input device flow. */
export interface DeviceAuthorizationChallenge {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  intervalMs: number;
  expiresAtMs: number;
}

export interface DriveDeviceAuthorizationPort {
  requestCode(
    client: DriveClientCredentials,
    signal: AbortSignal,
  ): Promise<DeviceAuthorizationChallenge>;
  poll(
    client: DriveClientCredentials,
    challenge: DeviceAuthorizationChallenge,
    signal: AbortSignal,
  ): Promise<OAuthTokenSet>;
  revoke(token: string, signal: AbortSignal): Promise<void>;
}

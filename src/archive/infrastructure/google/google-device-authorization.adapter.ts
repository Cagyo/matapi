import type {
  DeviceAuthorizationChallenge,
  DriveDeviceAuthorizationPort,
} from '../../application/ports/drive-device-authorization.port';
import type {
  DriveClientCredentials,
  OAuthTokenSet,
} from '../../application/ports/drive-credential-repository.port';
import { DriveAuthorizationDeniedError } from '../../domain/errors/drive-authorization-denied.error';
import { DriveAuthorizationPendingError } from '../../domain/errors/drive-authorization-pending.error';
import { DriveConfigurationError } from '../../domain/errors/drive-configuration.error';
import { DrivePolicyBlockedError } from '../../domain/errors/drive-policy-blocked.error';
import { DriveRateLimitedError } from '../../domain/errors/drive-rate-limited.error';
import { DriveReauthorizationRequiredError } from '../../domain/errors/drive-reauthorization-required.error';
import { DriveTemporaryUnavailableError } from '../../domain/errors/drive-temporary-unavailable.error';

const DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration';
const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DEFAULT_INTERVAL_MS = 5_000;

interface DiscoveryDocument {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
}

export interface DeviceAuthorizationClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface GoogleDeviceAuthorizationAdapterOptions {
  fetch?: typeof globalThis.fetch;
  clock?: DeviceAuthorizationClock;
}

/** Google limited-input-device protocol with fixed discovered endpoint allowlists. */
export class GoogleDeviceAuthorizationAdapter
  implements DriveDeviceAuthorizationPort
{
  private readonly request: typeof globalThis.fetch;
  private readonly clock: DeviceAuthorizationClock;

  constructor(options: GoogleDeviceAuthorizationAdapterOptions = {}) {
    this.request = options.fetch ?? globalThis.fetch;
    this.clock = options.clock ?? systemClock();
  }

  async requestCode(
    client: DriveClientCredentials,
    signal: AbortSignal,
  ): Promise<DeviceAuthorizationChallenge> {
    throwIfAborted(signal);
    const discovery = await this.discover(signal);
    const response = await this.postForm(
      discovery.deviceAuthorizationEndpoint,
      { client_id: client.clientId, scope: DRIVE_FILE_SCOPE },
      signal,
    );
    const body = await readObject(response, signal);
    throwIfAborted(signal);
    if (!response.ok) throw mapOAuthFailure(response.status, body.error);

    const deviceCode = readNonEmptyString(body.device_code);
    const userCode = readNonEmptyString(body.user_code);
    const verificationUri = readNonEmptyString(body.verification_uri);
    const expiresIn = readPositiveInteger(body.expires_in);
    if (!deviceCode || !userCode || !verificationUri || !expiresIn) {
      throw new DriveConfigurationError('Google device authorization response is invalid');
    }
    const intervalSeconds = readPositiveInteger(body.interval) ?? 5;
    const verificationUriComplete = readOptionalString(body.verification_uri_complete);
    if (verificationUriComplete === undefined) {
      throw new DriveConfigurationError('Google device authorization response is invalid');
    }
    return {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete,
      intervalMs: intervalSeconds * 1_000,
      expiresAtMs: this.clock.now() + expiresIn * 1_000,
    };
  }

  async poll(
    client: DriveClientCredentials,
    challenge: DeviceAuthorizationChallenge,
    signal: AbortSignal,
  ): Promise<OAuthTokenSet> {
    throwIfLive(challenge, this.clock.now());
    const deadline = AbortSignal.timeout(challenge.expiresAtMs - this.clock.now());
    const operationSignal = AbortSignal.any([signal, deadline]);
    try {
      const discovery = await this.discover(operationSignal);
      let intervalMs = challenge.intervalMs || DEFAULT_INTERVAL_MS;
      while (true) {
        throwIfAborted(signal);
        throwIfLive(challenge, this.clock.now());
        const response = await this.postForm(
          discovery.tokenEndpoint,
          {
            client_id: client.clientId,
            client_secret: client.clientSecret,
            device_code: challenge.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          },
          operationSignal,
        );
        const body = await readObject(response, operationSignal);
        throwIfAborted(signal);
        throwIfLive(challenge, this.clock.now());
        if (response.ok) return parseTokens(body, this.clock.now());

        switch (body.error) {
          case 'authorization_pending':
            await this.clock.sleep(remainingSleep(intervalMs, challenge, this.clock.now()), operationSignal);
            continue;
          case 'slow_down':
            intervalMs += 5_000;
            await this.clock.sleep(remainingSleep(intervalMs, challenge, this.clock.now()), operationSignal);
            continue;
          default:
            throw mapOAuthFailure(response.status, body.error);
        }
      }
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      if (deadline.aborted || this.clock.now() >= challenge.expiresAtMs) {
        throw new DriveReauthorizationRequiredError('Google device authorization expired');
      }
      throw error;
    }
  }

  async revoke(token: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const discovery = await this.discover(signal);
    const response = await this.postForm(
      discovery.revocationEndpoint,
      { token },
      signal,
    );
    if (response.ok) return;
    const body = await readObject(response, signal);
    throw mapOAuthFailure(response.status, body.error);
  }

  private async discover(signal: AbortSignal): Promise<DiscoveryDocument> {
    throwIfAborted(signal);
    let response: Response;
    try {
      response = await this.request(DISCOVERY_URL, {
        method: 'GET',
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      throw mapTransportFailure(error, signal);
    }
    rejectRedirect(response);
    if (!response.ok) throw new DriveTemporaryUnavailableError();
    const body = await readObject(response, signal);
    const document = {
      deviceAuthorizationEndpoint: readNonEmptyString(body.device_authorization_endpoint),
      tokenEndpoint: readNonEmptyString(body.token_endpoint),
      revocationEndpoint: readNonEmptyString(body.revocation_endpoint),
    };
    if (
      document.deviceAuthorizationEndpoint !== DEVICE_CODE_URL ||
      document.tokenEndpoint !== TOKEN_URL ||
      document.revocationEndpoint !== REVOKE_URL
    ) {
      throw new DriveConfigurationError('Google OAuth discovery endpoints are not allowlisted');
    }
    return document as DiscoveryDocument;
  }

  private async postForm(
    url: string,
    values: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Response> {
    throwIfAborted(signal);
    let response: Response;
    try {
      response = await this.request(url, {
        method: 'POST',
        redirect: 'manual',
        signal,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(values).toString(),
      });
    } catch (error) {
      throw mapTransportFailure(error, signal);
    }
    rejectRedirect(response);
    return response;
  }
}

async function readObject(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortError(signal));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const value: unknown = await Promise.race([response.json(), aborted]);
    return isRecord(value) ? value : {};
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw abortError(signal, error);
    return {};
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function parseTokens(body: Record<string, unknown>, nowMs: number): OAuthTokenSet {
  const accessToken = readOptionalString(body.access_token);
  const refreshToken = readOptionalString(body.refresh_token);
  const tokenType = readOptionalString(body.token_type);
  const scope = readOptionalString(body.scope);
  const expiresIn = readPositiveInteger(body.expires_in);
  if (accessToken === undefined || refreshToken === undefined || tokenType === undefined || scope === undefined || !accessToken || !expiresIn) {
    throw new DriveConfigurationError('Google token response is invalid');
  }
  return {
    accessToken,
    refreshToken,
    expiryDateMs: nowMs + expiresIn * 1_000,
    tokenType,
    scope,
  };
}

function mapOAuthFailure(status: number, error: unknown): Error {
  switch (error) {
    case 'authorization_pending': return new DriveAuthorizationPendingError();
    case 'access_denied': return new DriveAuthorizationDeniedError();
    case 'admin_policy_enforced':
    case 'org_internal': return new DrivePolicyBlockedError();
    case 'invalid_client': return new DriveConfigurationError('Google OAuth client is invalid');
    case 'invalid_grant':
    case 'expired_token': return new DriveReauthorizationRequiredError();
    default:
      if (status === 429) return new DriveRateLimitedError();
      if (status >= 500) return new DriveTemporaryUnavailableError();
      return new DriveTemporaryUnavailableError();
  }
}

function mapTransportFailure(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted || isAbortError(error)) return abortError(signal, error);
  return new DriveTemporaryUnavailableError();
}

function rejectRedirect(response: Response): void {
  if (response.status >= 300 && response.status < 400) {
    throw new DriveConfigurationError('Google OAuth redirects are not accepted');
  }
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readOptionalString(value: unknown): string | null | undefined {
  return value === undefined || value === null ? null : typeof value === 'string' ? value : undefined;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function throwIfLive(challenge: DeviceAuthorizationChallenge, nowMs: number): void {
  if (nowMs >= challenge.expiresAtMs) {
    throw new DriveReauthorizationRequiredError('Google device authorization expired');
  }
}

function remainingSleep(intervalMs: number, challenge: DeviceAuthorizationChallenge, nowMs: number): number {
  const remaining = challenge.expiresAtMs - nowMs;
  if (remaining <= 0) throw new DriveReauthorizationRequiredError('Google device authorization expired');
  return Math.min(intervalMs, remaining);
}

function abortError(signal: AbortSignal, fallback?: unknown): Error {
  if (signal.reason instanceof Error) return signal.reason;
  if (fallback instanceof Error && isAbortError(fallback)) return fallback;
  return new DOMException('Aborted', 'AbortError');
}

function isAbortError(value: unknown): value is Error {
  return value instanceof Error && value.name === 'AbortError';
}

function systemClock(): DeviceAuthorizationClock {
  return {
    now: () => Date.now(),
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
        return;
      }
      const timeout = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }),
  };
}

import { Logger } from '@nestjs/common';
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
import { DriveOAuthClientRejectedError } from '../../domain/errors/drive-oauth-client-rejected.error';
import { DrivePolicyBlockedError } from '../../domain/errors/drive-policy-blocked.error';
import { DriveProviderResponseError } from '../../domain/errors/drive-provider-response.error';
import { DriveRateLimitedError } from '../../domain/errors/drive-rate-limited.error';
import { DriveReauthorizationRequiredError } from '../../domain/errors/drive-reauthorization-required.error';
import { DriveTemporaryUnavailableError } from '../../domain/errors/drive-temporary-unavailable.error';

const DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration';
const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_OAUTH_BODY_BYTES = 64 * 1024;
const MAX_DEVICE_CODE_BYTES = 4_096;
const MAX_USER_CODE_BYTES = 64;
const MAX_VERIFICATION_URL_BYTES = 2_048;

interface DiscoveryDocument {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
}

interface OAuthResponse {
  response: Response;
  body: Record<string, unknown>;
}

export interface DeviceAuthorizationClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface GoogleDeviceAuthorizationAdapterOptions {
  fetch?: typeof globalThis.fetch;
  clock: DeviceAuthorizationClock;
  requestTimeoutMs?: number;
}

/** Google limited-input-device protocol with fixed discovered endpoint allowlists. */
export class GoogleDeviceAuthorizationAdapter
  implements DriveDeviceAuthorizationPort
{
  private readonly request: typeof globalThis.fetch;
  private readonly clock: DeviceAuthorizationClock;
  private readonly requestTimeoutMs: number;
  private readonly logger = new Logger(GoogleDeviceAuthorizationAdapter.name);

  constructor(options: GoogleDeviceAuthorizationAdapterOptions) {
    if (!options.clock) throw new DriveConfigurationError('Device authorization clock is required');
    this.request = options.fetch ?? globalThis.fetch;
    this.clock = options.clock;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async requestCode(
    client: DriveClientCredentials,
    signal: AbortSignal,
  ): Promise<DeviceAuthorizationChallenge> {
    throwIfAborted(signal);
    const discovery = await this.discover(signal);
    const { response, body } = await this.postForm(
      discovery.deviceAuthorizationEndpoint,
      { client_id: client.clientId, scope: DRIVE_FILE_SCOPE },
      signal,
    );
    throwIfAborted(signal);
    if (!response.ok) throw this.mapFailure('device-code', response.status, body);

    const deviceCode = boundedString(body.device_code, MAX_DEVICE_CODE_BYTES);
    const userCode = printableAscii(body.user_code, MAX_USER_CODE_BYTES) ? body.user_code : null;
    const verificationUri = readDisplayUrl(body.verification_url);
    const expiresMs = safePositiveMilliseconds(body.expires_in);
    const intervalMs = body.interval === undefined ? DEFAULT_INTERVAL_MS : safePositiveMilliseconds(body.interval);
    const verificationUriComplete = body.verification_url_complete === undefined
      ? null : readDisplayUrl(body.verification_url_complete);
    if (!deviceCode || !userCode || !verificationUri || expiresMs === null
      || intervalMs === null || (body.verification_url_complete !== undefined && verificationUriComplete === null)) {
      throw new DriveProviderResponseError();
    }
    const nowMs = this.clock.now();
    if (!Number.isSafeInteger(nowMs + expiresMs)) throw new DriveProviderResponseError();
    return {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete,
      intervalMs,
      expiresAtMs: nowMs + expiresMs,
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
        const { response, body } = await this.postForm(
          discovery.tokenEndpoint,
          {
            client_id: client.clientId,
            client_secret: client.clientSecret,
            device_code: challenge.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          },
          operationSignal,
        );
        throwIfAborted(signal);
        throwIfLive(challenge, this.clock.now());
        if (response.ok) return parseTokens(body, this.clock.now());

        switch (failureDiscriminator('token', body)) {
          case 'authorization_pending':
            await this.clock.sleep(remainingSleep(intervalMs, challenge, this.clock.now()), operationSignal);
            continue;
          case 'slow_down':
            intervalMs += 5_000;
            await this.clock.sleep(remainingSleep(intervalMs, challenge, this.clock.now()), operationSignal);
            continue;
          default:
            throw this.mapFailure('token', response.status, body);
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
    const { response, body } = await this.postForm(
      discovery.revocationEndpoint,
      { token },
      signal,
      false,
    );
    if (response.ok) return;
    throw this.mapFailure('revoke', response.status, body);
  }

  private async discover(signal: AbortSignal): Promise<DiscoveryDocument> {
    throwIfAborted(signal);
    const body = await this.requestWithTimeout(signal, async (requestSignal) => {
      const response = await this.request(DISCOVERY_URL, {
        method: 'GET',
        redirect: 'manual',
        signal: requestSignal,
      });
      rejectRedirect(response);
      if (!response.ok) throw new DriveTemporaryUnavailableError();
      return readObject(response, requestSignal);
    });
    const document = {
      deviceAuthorizationEndpoint: boundedString(body.device_authorization_endpoint, MAX_VERIFICATION_URL_BYTES),
      tokenEndpoint: boundedString(body.token_endpoint, MAX_VERIFICATION_URL_BYTES),
      revocationEndpoint: boundedString(body.revocation_endpoint, MAX_VERIFICATION_URL_BYTES),
    };
    if (
      document.deviceAuthorizationEndpoint !== DEVICE_CODE_URL ||
      document.tokenEndpoint !== TOKEN_URL ||
      document.revocationEndpoint !== REVOKE_URL
    ) {
      throw new DriveProviderResponseError();
    }
    return document as DiscoveryDocument;
  }

  private async postForm(
    url: string,
    values: Record<string, string>,
    signal: AbortSignal,
    readSuccessBody = true,
  ): Promise<OAuthResponse> {
    throwIfAborted(signal);
    return this.requestWithTimeout(signal, async (requestSignal) => {
      const response = await this.request(url, {
        method: 'POST',
        redirect: 'manual',
        signal: requestSignal,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(values).toString(),
      });
      rejectRedirect(response);
      if (response.ok && !readSuccessBody) {
        await drainBody(response, requestSignal);
        return { response, body: {} };
      }
      return {
        response,
        body: await readObject(response, requestSignal),
      };
    });
  }

  private async requestWithTimeout<T>(
    callerSignal: AbortSignal,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    throwIfAborted(callerSignal);
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    try {
      return await execute(AbortSignal.any([callerSignal, timeout]));
    } catch (error) {
      if (callerSignal.aborted) throw abortError(callerSignal, error);
      if (timeout.aborted) throw new DriveTemporaryUnavailableError();
      if (error instanceof DriveProviderResponseError
        || error instanceof DriveConfigurationError
        || error instanceof DriveTemporaryUnavailableError) throw error;
      throw mapTransportFailure(error, callerSignal);
    }
  }

  private mapFailure(
    endpoint: 'device-code' | 'token' | 'revoke',
    status: number,
    body: Record<string, unknown>,
  ): Error {
    const discriminator = failureDiscriminator(endpoint, body);
    if (status >= 400 && status < 500 && !isRecognizedOAuthFailure(discriminator)) {
      this.logger.warn({ status, code: 'unrecognized_oauth_error' });
    }
    return mapOAuthFailure(status, discriminator);
  }
}

async function readObject(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.body) throw new DriveProviderResponseError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await readChunk(reader, signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_OAUTH_BODY_BYTES) throw new DriveProviderResponseError();
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  throwIfAborted(signal);
  let value: unknown;
  try {
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof DriveProviderResponseError) throw error;
    throw new DriveProviderResponseError();
  }
  if (!isRecord(value)) throw new DriveProviderResponseError();
  return value;
}

async function drainBody(response: Response, signal: AbortSignal): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const next = await readChunk(reader, signal);
      if (next.done) return;
      size += next.value.byteLength;
      if (size > MAX_OAUTH_BODY_BYTES) throw new DriveProviderResponseError();
    }
  } finally {
    reader.releaseLock();
  }
}

function parseTokens(body: Record<string, unknown>, nowMs: number): OAuthTokenSet {
  const accessToken = readOptionalString(body.access_token);
  const refreshToken = readOptionalString(body.refresh_token);
  const tokenType = readOptionalString(body.token_type);
  const scope = readOptionalString(body.scope);
  const expiresMs = safePositiveMilliseconds(body.expires_in);
  if (accessToken === undefined || refreshToken === undefined || tokenType === undefined || scope === undefined || !accessToken || expiresMs === null
    || !Number.isSafeInteger(nowMs + expiresMs)) {
    throw new DriveProviderResponseError();
  }
  return {
    accessToken,
    refreshToken,
    expiryDateMs: nowMs + expiresMs,
    tokenType,
    scope,
  };
}

function failureDiscriminator(endpoint: 'device-code' | 'token' | 'revoke', body: Record<string, unknown>): unknown {
  return endpoint === 'device-code' ? body.error_code ?? body.error : body.error;
}

function mapOAuthFailure(status: number, discriminator: unknown): Error {
  switch (discriminator) {
    case 'authorization_pending': return new DriveAuthorizationPendingError();
    case 'access_denied': return new DriveAuthorizationDeniedError();
    case 'admin_policy_enforced':
    case 'org_internal': return new DrivePolicyBlockedError();
    case 'invalid_client': return new DriveOAuthClientRejectedError();
    case 'invalid_grant':
    case 'expired_token': return new DriveReauthorizationRequiredError();
    case 'rate_limit_exceeded': return new DriveRateLimitedError();
    default:
      if (status === 429) return new DriveRateLimitedError();
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

function boundedString(value: unknown, maxBytes: number): string | null {
  return typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes ? value : null;
}

function printableAscii(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxBytes
    && /^[\x20-\x7e]+$/.test(value);
}

function readDisplayUrl(value: unknown): string | null {
  if (!printableAscii(value, MAX_VERIFICATION_URL_BYTES)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
      ? value : null;
  } catch {
    return null;
  }
}

function safePositiveMilliseconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    && value <= Math.floor(Number.MAX_SAFE_INTEGER / 1_000) ? value * 1_000 : null;
}

function readOptionalString(value: unknown): string | null | undefined {
  return value === undefined || value === null ? null : typeof value === 'string' ? value : undefined;
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

function isRecognizedOAuthFailure(value: unknown): boolean {
  return value === 'authorization_pending'
    || value === 'slow_down'
    || value === 'access_denied'
    || value === 'admin_policy_enforced'
    || value === 'org_internal'
    || value === 'invalid_client'
    || value === 'invalid_grant'
    || value === 'expired_token'
    || value === 'rate_limit_exceeded';
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
) {
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        void reader.cancel().catch(() => undefined);
        reject(abortError(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

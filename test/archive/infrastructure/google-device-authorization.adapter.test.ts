import { describe, expect, it, vi } from 'vitest';
import { GoogleDeviceAuthorizationAdapter } from '../../../src/archive/infrastructure/google/google-device-authorization.adapter';
import { DriveAuthorizationDeniedError } from '../../../src/archive/domain/errors/drive-authorization-denied.error';
import { DriveConfigurationError } from '../../../src/archive/domain/errors/drive-configuration.error';
import { DriveOAuthClientRejectedError } from '../../../src/archive/domain/errors/drive-oauth-client-rejected.error';
import { DrivePolicyBlockedError } from '../../../src/archive/domain/errors/drive-policy-blocked.error';
import { DriveProviderResponseError } from '../../../src/archive/domain/errors/drive-provider-response.error';
import { DriveRateLimitedError } from '../../../src/archive/domain/errors/drive-rate-limited.error';
import { DriveReauthorizationRequiredError } from '../../../src/archive/domain/errors/drive-reauthorization-required.error';
import { DriveTemporaryUnavailableError } from '../../../src/archive/domain/errors/drive-temporary-unavailable.error';

interface RequestRecord { url: string; init: RequestInit }

class Transport {
  readonly requests: RequestRecord[] = [];
  private readonly responses: Response[] = [];

  enqueue(status: number, body: Record<string, unknown>, headers?: HeadersInit): void {
    this.responses.push(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }));
  }

  async fetch(url: string | URL, init: RequestInit): Promise<Response> {
    this.requests.push({ url: String(url), init });
    const response = this.responses.shift();
    if (!response) throw new Error('No queued response');
    return response;
  }
}

class Clock {
  nowMs = 1_700_000_000_000;
  readonly sleeps: number[] = [];

  now(): number { return this.nowMs; }
  async sleep(ms: number): Promise<void> { this.sleeps.push(ms); }
}

const client = () => ({ clientId: 'client-id', clientSecret: 'client-secret' });
const challenge = () => ({
  deviceCode: 'device-code',
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://www.google.com/device',
  verificationUriComplete: null,
  intervalMs: 5_000,
  expiresAtMs: 1_700_000_060_000,
});
const signal = new AbortController().signal;

describe('GoogleDeviceAuthorizationAdapter', () => {
  it('adds five seconds after Google returns slow_down', async () => {
    const transport = new Transport();
    const clock = new Clock();
    transport.enqueue(200, discovery());
    transport.enqueue(403, { error: 'slow_down' });
    transport.enqueue(428, { error: 'authorization_pending' });
    transport.enqueue(200, tokens());
    const adapter = new GoogleDeviceAuthorizationAdapter({ fetch: transport.fetch.bind(transport), clock });

    await adapter.poll(client(), challenge(), signal);

    expect(clock.sleeps).toEqual([10_000, 10_000]);
  });

  it('ignores uploaded endpoint fields and rejects cross-origin discovery', async () => {
    const transport = new Transport();
    const clock = new Clock();
    transport.enqueue(200, {
      device_authorization_endpoint: 'https://evil.example/device',
      token_endpoint: 'https://oauth2.googleapis.com/token',
      revocation_endpoint: 'https://oauth2.googleapis.com/revoke',
    });
    const adapter = new GoogleDeviceAuthorizationAdapter({ fetch: transport.fetch.bind(transport), clock });

    await expect(adapter.requestCode({ ...client(), deviceAuthorizationEndpoint: 'https://evil.example/device' } as never, signal))
      .rejects.toThrow(DriveProviderResponseError);

    expect(transport.requests.some((request) => request.url.includes('evil.example'))).toBe(false);
  });

  it('maps denied approval without exposing provider content', async () => {
    const transport = new Transport();
    const clock = new Clock();
    transport.enqueue(200, discovery());
    transport.enqueue(400, { error: 'access_denied', error_description: 'private content' });
    const adapter = new GoogleDeviceAuthorizationAdapter({ fetch: transport.fetch.bind(transport), clock });

    await expect(adapter.poll(client(), challenge(), signal)).rejects.toThrow(DriveAuthorizationDeniedError);
  });

  it('parses verification_url and preserves the case-sensitive user code', async () => {
    const transport = new Transport();
    const clock = new Clock();
    transport.enqueue(200, discovery());
    transport.enqueue(200, {
      device_code: 'device-code', user_code: 'aB9-Zx2',
      verification_url: 'https://www.google.com/device', expires_in: 600,
    });
    const adapter = new GoogleDeviceAuthorizationAdapter({ fetch: transport.fetch.bind(transport), clock });

    await expect(adapter.requestCode(client(), signal)).resolves.toEqual({
      deviceCode: 'device-code', userCode: 'aB9-Zx2',
      verificationUri: 'https://www.google.com/device', verificationUriComplete: null,
      intervalMs: 5_000, expiresAtMs: clock.nowMs + 600_000,
    });

    expect(new URLSearchParams(String(transport.requests[1].init.body)).get('scope'))
      .toBe('https://www.googleapis.com/auth/drive.file');
  });

  it.each([
    [{ device_code: '', user_code: 'ABC', verification_url: 'https://google.com/device', expires_in: 10 }],
    [{ device_code: 'd', user_code: '\nBAD', verification_url: 'https://google.com/device', expires_in: 10 }],
    [{ device_code: 'd', user_code: 'ABC', verification_url: '/relative', expires_in: 10 }],
    [{ device_code: 'd', user_code: 'ABC', verification_url: 'https://user:pass@google.com/device', expires_in: 10 }],
    [{ device_code: 'd', user_code: 'ABC', verification_url: 'ftp://google.com/device', expires_in: 10 }],
    [{ device_code: 'd', user_code: 'ABC', verification_url: 'https://google.com/device', expires_in: Number.MAX_SAFE_INTEGER }],
  ])('rejects malformed successful device-code fields', async (body) => {
    const transport = new Transport();
    transport.enqueue(200, discovery());
    transport.enqueue(200, body);

    await expect(new GoogleDeviceAuthorizationAdapter({ fetch: transport.fetch.bind(transport), clock: new Clock() })
      .requestCode(client(), signal)).rejects.toBeInstanceOf(DriveProviderResponseError);
  });

  it.each([
    [429, { error: 'rate_limit_exceeded' }, DriveRateLimitedError],
    [400, { error: 'invalid_client' }, DriveOAuthClientRejectedError],
    [400, { error: 'admin_policy_enforced' }, DrivePolicyBlockedError],
  ])('maps provider rejection %s to its typed domain error', async (status, body, error) => {
    const transport = new Transport();
    transport.enqueue(200, discovery());
    transport.enqueue(status, body);
    const adapter = new GoogleDeviceAuthorizationAdapter({ fetch: transport.fetch.bind(transport), clock: new Clock() });

    await expect(adapter.requestCode(client(), signal)).rejects.toThrow(error);
  });

  it('maps device-code error_code rate_limit_exceeded and token invalid_client', async () => {
    const device = new Transport();
    device.enqueue(200, discovery());
    device.enqueue(403, { error_code: 'rate_limit_exceeded' });
    await expect(new GoogleDeviceAuthorizationAdapter({ fetch: device.fetch.bind(device), clock: new Clock() })
      .requestCode(client(), signal)).rejects.toBeInstanceOf(DriveRateLimitedError);

    const token = new Transport();
    token.enqueue(200, discovery());
    token.enqueue(401, { error: 'invalid_client' });
    await expect(new GoogleDeviceAuthorizationAdapter({ fetch: token.fetch.bind(token), clock: new Clock() })
      .poll(client(), challenge(), signal)).rejects.toBeInstanceOf(DriveOAuthClientRejectedError);
  });

  it('rejects an OAuth JSON body larger than 64 KiB', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(discovery())))
      .mockResolvedValueOnce(new Response(`{"device_code":"${'x'.repeat(64 * 1024)}"}`));
    await expect(new GoogleDeviceAuthorizationAdapter({ fetch, clock: new Clock() })
      .requestCode(client(), signal)).rejects.toBeInstanceOf(DriveProviderResponseError);
  });

  it('maps transport timeout to temporary unavailable but preserves caller abort', async () => {
    const never = vi.fn((_url: string | URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const adapter = new GoogleDeviceAuthorizationAdapter({ fetch: never, clock: new Clock(), requestTimeoutMs: 1 });
    await expect(adapter.requestCode(client(), signal)).rejects.toBeInstanceOf(DriveTemporaryUnavailableError);

    const controller = new AbortController();
    const pending = adapter.requestCode(client(), controller.signal);
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('maps a locally timed-out stalled OAuth response body to temporary unavailable', async () => {
    let stalledController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stalledBody = new ReadableStream<Uint8Array>({
      start(controller) {
        stalledController = controller;
      },
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(discovery())))
      .mockImplementationOnce((_url: string | URL, init: RequestInit) => {
        init.signal?.addEventListener('abort', () => stalledController?.error(init.signal?.reason), { once: true });
        return new Response(stalledBody);
      });
    const adapter = new GoogleDeviceAuthorizationAdapter({ fetch, clock: new Clock(), requestTimeoutMs: 1 });

    await expect(adapter.requestCode(client(), signal)).rejects.toBeInstanceOf(DriveTemporaryUnavailableError);
  });

  it('accepts a successful revoke with no response body', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(discovery())))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const adapter = new GoogleDeviceAuthorizationAdapter({ fetch, clock: new Clock() });

    await expect(adapter.revoke('token', signal)).resolves.toBeUndefined();
  });

  it('rejects every manual redirect before following it', async () => {
    const transport = new Transport();
    transport.enqueue(302, {});
    const adapter = new GoogleDeviceAuthorizationAdapter({ fetch: transport.fetch.bind(transport), clock: new Clock() });

    await expect(adapter.requestCode(client(), signal)).rejects.toThrow(DriveConfigurationError);
    expect(transport.requests).toHaveLength(1);
  });

  it('rejects approval that arrives after the challenge expires', async () => {
    const transport = new Transport();
    const clock = new Clock();
    const expiresAtMs = challenge().expiresAtMs;
    transport.enqueue(200, discovery());
    transport.enqueue(200, tokens());
    const fetch = async (url: string | URL, init: RequestInit) => {
      const response = await transport.fetch(url, init);
      if (String(url).endsWith('/token')) clock.nowMs = expiresAtMs;
      return response;
    };
    const adapter = new GoogleDeviceAuthorizationAdapter({ fetch, clock });

    await expect(adapter.poll(client(), challenge(), signal)).rejects.toThrow(DriveReauthorizationRequiredError);
  });

  it('propagates caller cancellation as AbortError', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));
    const fetch = vi.fn();
    const adapter = new GoogleDeviceAuthorizationAdapter({ fetch, clock: new Clock() });

    await expect(adapter.poll(client(), challenge(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels an in-flight response-body read as AbortError', async () => {
    const controller = new AbortController();
    const responseBody = new ReadableStream<Uint8Array>({ start: () => undefined });
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, body: responseBody });
    const adapter = new GoogleDeviceAuthorizationAdapter({ fetch, clock: new Clock() });
    const pending = adapter.requestCode(client(), controller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('bounds a pending poll sleep to the remaining challenge lifetime', async () => {
    const transport = new Transport();
    const clock = new Clock();
    const nearExpiry = { ...challenge(), expiresAtMs: clock.nowMs + 1_000 };
    clock.sleep = async (ms: number) => {
      clock.sleeps.push(ms);
      clock.nowMs += ms;
    };
    transport.enqueue(200, discovery());
    transport.enqueue(428, { error: 'authorization_pending' });
    const adapter = new GoogleDeviceAuthorizationAdapter({ fetch: transport.fetch.bind(transport), clock });

    await expect(adapter.poll(client(), nearExpiry, signal)).rejects.toThrow(DriveReauthorizationRequiredError);
    expect(clock.sleeps).toEqual([1_000]);
  });
});

function discovery(): Record<string, string> {
  return {
    device_authorization_endpoint: 'https://oauth2.googleapis.com/device/code',
    token_endpoint: 'https://oauth2.googleapis.com/token',
    revocation_endpoint: 'https://oauth2.googleapis.com/revoke',
  };
}

function tokens(): Record<string, unknown> {
  return { access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/drive.file' };
}

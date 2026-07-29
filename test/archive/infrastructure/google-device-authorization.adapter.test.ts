import { describe, expect, it } from 'vitest';
import { GoogleDeviceAuthorizationAdapter } from '../../../src/archive/infrastructure/google/google-device-authorization.adapter';
import { DriveAuthorizationDeniedError } from '../../../src/archive/domain/errors/drive-authorization-denied.error';
import { DriveConfigurationError } from '../../../src/archive/domain/errors/drive-configuration.error';

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
      .rejects.toThrow(DriveConfigurationError);

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

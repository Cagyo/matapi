import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  GoogleResumableUploadGateway,
  type GoogleResumableTransport,
  type GoogleResumableTransportRequest,
  type GoogleResumableTransportResponse,
} from '../../../src/archive/infrastructure/google/google-resumable-upload.gateway';

const signal = new AbortController().signal;
const validLocation = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=opaque-id&ignoreDefaultVisibility=true';
const beginInput = {
  authorization: 'Bearer token',
  fileId: 'reserved-1',
  parentId: 'folder-1',
  name: 'clip.mp4',
  mimeType: 'video/mp4',
  size: 42,
  appProperties: { a1v: '1' },
} as const;

describe('GoogleResumableUploadGateway', () => {
  it.each([
    [403, 'rateLimitExceeded', 'DriveRateLimitedError'],
    [429, null, 'DriveRateLimitedError'],
    [403, 'dailyLimitExceeded', 'DriveProviderCapacityBlockedError'],
    [403, 'activeItemCreationLimitExceeded', 'DriveProviderCapacityBlockedError'],
    [403, 'storageQuotaExceeded', 'DriveQuotaExceededError'],
    [403, 'domainPolicy', 'DrivePolicyBlockedError'],
    [401, 'authError', 'DriveReauthorizationRequiredError'],
  ] as const)('maps %s/%s by reason before status fallback', async (status, reason, name) => {
    const transport = new FakeTransport(providerErrorResponse(status, reason, { 'retry-after': '120' }));

    await expect(new GoogleResumableUploadGateway(transport).querySession({
      authorization: 'Bearer token', uri: validLocation, totalSize: 42,
    }, signal)).rejects.toMatchObject({ name });
  });

  it('marks a session-phase rate limit and ordinary 4xx as unusable without exposing provider text', async () => {
    const rateLimit = new GoogleResumableUploadGateway(new FakeTransport(providerErrorResponse(
      429, null, { 'retry-after': 'Thu, 13 Aug 2026 00:02:00 GMT' }, 'access_token=secret',
    )), { now: () => Date.parse('Thu, 13 Aug 2026 00:00:00 GMT') });
    await expect(rateLimit.uploadChunk({
      authorization: 'Bearer token', uri: validLocation, start: 0, endInclusive: 41,
      totalSize: 42, body: Readable.from([Buffer.alloc(42)]),
    }, signal)).rejects.toMatchObject({
      name: 'DriveRateLimitedError',
      message: 'Drive rate limit was reached',
      detail: { retryAfterMs: 120_000, sessionUsable: false, operationPhase: 'session-chunk' },
    });

    await expect(new GoogleResumableUploadGateway(new FakeTransport(providerErrorResponse(400, null, {})))
      .querySession({ authorization: 'Bearer token', uri: validLocation, totalSize: 42 }, signal))
      .rejects.toMatchObject({ name: 'DriveTemporaryUnavailableError', sessionUsable: false });
  });

  it('honors an allowlisted authorization or policy reason before 404 session expiry', async () => {
    const gateway = new GoogleResumableUploadGateway(new FakeTransport(
      providerErrorResponse(404, 'domainPolicy', {}),
    ));

    await expect(gateway.querySession({
      authorization: 'Bearer token', uri: validLocation, totalSize: 42,
    }, signal)).rejects.toMatchObject({ name: 'DrivePolicyBlockedError' });
  });

  it.each([
    [200, 'complete'],
    [201, 'complete'],
    [308, 'resume'],
    [404, 'expired'],
  ] as const)('maps persisted-session status %s', async (status, expected) => {
    const transport = new FakeTransport({ status, headers: status === 308 ? { range: 'bytes=0-524287' } : {} });
    const gateway = new GoogleResumableUploadGateway(transport);

    await expect(gateway.querySession({ authorization: 'Bearer token', uri: validLocation, totalSize: 1_000_000 }, signal))
      .resolves.toMatchObject({ kind: expected });
  });

  it('uses the server Range as the only confirmed offset', async () => {
    const gateway = new GoogleResumableUploadGateway(new FakeTransport({ status: 308, headers: { range: 'bytes=0-262143' } }));

    await expect(gateway.querySession({ authorization: 'Bearer token', uri: validLocation, totalSize: 1_000_000 }, signal))
      .resolves.toEqual({ kind: 'resume', confirmedOffset: 262_144 });
  });

  it.each([
    [
      'with a Google-controlled auxiliary parameter',
      validLocation,
    ],
    [
      'without the optional uploadType parameter',
      'https://www.googleapis.com/upload/drive/v3/files?upload_id=opaque-id&ignoreDefaultVisibility=true',
    ],
  ] as const)('accepts and preserves a valid session URI %s', async (_case, location) => {
    const transport = new FakeTransport({ status: 200, headers: { location } });
    const gateway = new GoogleResumableUploadGateway(transport, { now: () => 100 });

    await expect(gateway.begin(beginInput, signal)).resolves.toEqual({
      uri: location,
      createdAtMs: 100,
      expiresAtMs: 518_400_100,
    });
  });

  it('uses the exact validated persisted URI for a status PUT', async () => {
    const location = 'https://www.googleapis.com:443/upload/drive/v3/files?upload_id=opaque-id&ignoreDefaultVisibility=true';
    const transport = new FakeTransport({ status: 308, headers: {} });
    const gateway = new GoogleResumableUploadGateway(transport);

    await expect(gateway.querySession({
      authorization: 'Bearer token',
      uri: location,
      totalSize: 42,
    }, signal)).resolves.toEqual({ kind: 'resume', confirmedOffset: 0 });
    expect(transport.requests[0].url).toBe(location);
  });

  it.each([
    ['a missing Location header', undefined],
    ['a relative URL', '/upload/drive/v3/files?upload_id=x'],
    ['HTTP', 'http://www.googleapis.com/upload/drive/v3/files?upload_id=x'],
    ['embedded credentials', 'https://user:pass@www.googleapis.com/upload/drive/v3/files?upload_id=x'],
    ['a foreign host', 'https://evil.example/upload/drive/v3/files?upload_id=x'],
    ['a suffix-confusable host', 'https://www.googleapis.com.evil.example/upload/drive/v3/files?upload_id=x'],
    ['a non-default port', 'https://www.googleapis.com:444/upload/drive/v3/files?upload_id=x'],
    ['a different path', 'https://www.googleapis.com/upload/drive/v3/files/extra?upload_id=x'],
    ['a fragment', 'https://www.googleapis.com/upload/drive/v3/files?upload_id=x#fragment'],
    ['a missing upload_id', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable'],
    ['an empty upload_id', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id='],
    ['duplicate upload_id values', 'https://www.googleapis.com/upload/drive/v3/files?upload_id=x&upload_id=y'],
    ['an empty uploadType', 'https://www.googleapis.com/upload/drive/v3/files?upload_id=x&uploadType='],
    ['an invalid uploadType', 'https://www.googleapis.com/upload/drive/v3/files?upload_id=x&uploadType=multipart'],
    ['duplicate resumable uploadType values', 'https://www.googleapis.com/upload/drive/v3/files?upload_id=x&uploadType=resumable&uploadType=resumable'],
    ['mixed duplicate uploadType values', 'https://www.googleapis.com/upload/drive/v3/files?upload_id=x&uploadType=resumable&uploadType=multipart'],
  ] as const)('rejects %s with the sanitized configuration error', async (_case, location) => {
    const transport = new FakeTransport({ status: 200, headers: { location } });
    const gateway = new GoogleResumableUploadGateway(transport);

    await expect(gateway.begin(beginInput, signal)).rejects.toMatchObject({
      name: 'DriveConfigurationError',
      code: 'DRIVE_CONFIGURATION',
      message: 'Google resumable Location is not allowlisted',
    });
  });

  it('returns an allowlisted initiation URI and applies bounded transport deadlines', async () => {
    const transport = new FakeTransport({ status: 200, headers: { location: validLocation } });
    const gateway = new GoogleResumableUploadGateway(transport, {
      now: () => 100, connectTimeoutMs: 1_000, responseTimeoutMs: 2_000, idleTimeoutMs: 3_000, totalTimeoutMs: 4_000,
    });

    await expect(gateway.begin(beginInput, signal)).resolves.toEqual({ uri: validLocation, createdAtMs: 100, expiresAtMs: 518_400_100 });
    expect(transport.requests[0].deadlines).toEqual({ connectMs: 1_000, responseMs: 2_000, idleMs: 3_000, totalMs: 4_000 });
  });

  it('streams an aligned non-final chunk without buffering the body', async () => {
    const transport = new FakeTransport({ status: 308, headers: { range: 'bytes=0-262143' } });
    const gateway = new GoogleResumableUploadGateway(transport);
    const body = Readable.from([Buffer.alloc(64 * 1024), Buffer.alloc(192 * 1024)]);

    await expect(gateway.uploadChunk({
      authorization: 'Bearer token', uri: validLocation, start: 0, endInclusive: 262_143,
      totalSize: 300_000, body,
    }, signal)).resolves.toEqual({ kind: 'resume', confirmedOffset: 262_144 });
    expect(transport.largestBodyPart).toBe(192 * 1024);
    expect(transport.requests[0].body).not.toBeInstanceOf(Buffer);
  });

  it('rejects a non-final chunk that is not a 256 KiB multiple before transport', async () => {
    const transport = new FakeTransport({ status: 308, headers: {} });
    const gateway = new GoogleResumableUploadGateway(transport);

    await expect(gateway.uploadChunk({
      authorization: 'Bearer token', uri: validLocation, start: 0, endInclusive: 99,
      totalSize: 1_000, body: Readable.from([Buffer.alloc(100)]),
    }, signal)).rejects.toThrow('256 KiB');
    expect(transport.requests).toHaveLength(0);
  });

  it('honors caller cancellation before any request', async () => {
    const transport = new FakeTransport({ status: 200, headers: {} });
    const controller = new AbortController();
    controller.abort(new Error('stop'));

    await expect(new GoogleResumableUploadGateway(transport).querySession({
      authorization: 'Bearer token', uri: validLocation, totalSize: 1,
    }, controller.signal)).rejects.toThrow('stop');
    expect(transport.requests).toHaveLength(0);
  });
});

function providerErrorResponse(
  status: number,
  reason: string | null,
  headers: Readonly<Record<string, string>>,
  message = 'provider failure',
): GoogleResumableTransportResponse {
  return {
    status,
    headers,
    body: Buffer.from(JSON.stringify({
      error: { errors: reason === null ? [] : [{ reason }], code: status, message },
    }), 'utf8'),
  };
}

class FakeTransport implements GoogleResumableTransport {
  readonly requests: GoogleResumableTransportRequest[] = [];
  largestBodyPart = 0;

  constructor(private readonly response: GoogleResumableTransportResponse) {}

  async request(input: GoogleResumableTransportRequest): Promise<GoogleResumableTransportResponse> {
    this.requests.push(input);
    if (input.body !== undefined && typeof input.body !== 'string') {
      for await (const part of input.body) this.largestBodyPart = Math.max(this.largestBodyPart, part.byteLength);
    }
    return this.response;
  }
}

import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  GoogleResumableUploadGateway,
  type GoogleResumableTransport,
  type GoogleResumableTransportRequest,
  type GoogleResumableTransportResponse,
} from '../../../src/archive/infrastructure/google/google-resumable-upload.gateway';

const signal = new AbortController().signal;
const validLocation = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=opaque-id';

describe('GoogleResumableUploadGateway', () => {
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
    'http://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=x',
    'https://user:pass@www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=x',
    'https://evil.example/upload/drive/v3/files?uploadType=resumable&upload_id=x',
    'https://www.googleapis.com/upload/drive/v3/files/extra?uploadType=resumable&upload_id=x',
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=x&access_token=secret',
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=x&upload_id=y',
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=x#fragment',
  ])('rejects a non-allowlisted resumable Location without returning it: %s', async (location) => {
    const gateway = new GoogleResumableUploadGateway(new FakeTransport({ status: 200, headers: { location } }));

    await expect(gateway.begin({
      authorization: 'Bearer token', fileId: 'reserved-1', parentId: 'folder-1', name: 'clip.mp4',
      mimeType: 'video/mp4', size: 42, appProperties: { a1v: '1' },
    }, signal)).rejects.toThrow('allowlisted');
  });

  it('returns an allowlisted initiation URI and applies bounded transport deadlines', async () => {
    const transport = new FakeTransport({ status: 200, headers: { location: validLocation } });
    const gateway = new GoogleResumableUploadGateway(transport, {
      now: () => 100, connectTimeoutMs: 1_000, responseTimeoutMs: 2_000, idleTimeoutMs: 3_000, totalTimeoutMs: 4_000,
    });

    await expect(gateway.begin({
      authorization: 'Bearer token', fileId: 'reserved-1', parentId: 'folder-1', name: 'clip.mp4',
      mimeType: 'video/mp4', size: 42, appProperties: { a1v: '1' },
    }, signal)).resolves.toEqual({ uri: validLocation, createdAtMs: 100, expiresAtMs: 518_400_100 });
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FetchHeartbeatAdapter } from '../../../src/network/infrastructure/fetch-heartbeat.adapter';

const originalUrl = process.env.HEARTBEAT_URL;
const originalFetch = globalThis.fetch;

describe('FetchHeartbeatAdapter', () => {
  beforeEach(() => {
    delete process.env.HEARTBEAT_URL;
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.HEARTBEAT_URL;
    else process.env.HEARTBEAT_URL = originalUrl;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('is a no-op when HEARTBEAT_URL is unset', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    await new FetchHeartbeatAdapter().pingExternal();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GETs the configured URL with a timeout signal', async () => {
    process.env.HEARTBEAT_URL = 'https://heartbeat.example/ping';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock;

    await new FetchHeartbeatAdapter().pingExternal();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://heartbeat.example/ping');
    expect(init.method).toBe('GET');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('propagates network failures to the caller', async () => {
    process.env.HEARTBEAT_URL = 'https://heartbeat.example/ping';
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    globalThis.fetch = fetchMock;

    await expect(new FetchHeartbeatAdapter().pingExternal()).rejects.toThrow(
      'offline',
    );
  });
});

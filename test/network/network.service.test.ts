import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkService } from '../../src/network/network.service';

const originalHeartbeatUrl = process.env.HEARTBEAT_URL;
const originalHeartbeatInterval = process.env.HEARTBEAT_INTERVAL_MS;
const originalFetch = globalThis.fetch;

describe('NetworkService', () => {
  afterEach(() => {
    if (originalHeartbeatUrl === undefined) {
      delete process.env.HEARTBEAT_URL;
    } else {
      process.env.HEARTBEAT_URL = originalHeartbeatUrl;
    }
    if (originalHeartbeatInterval === undefined) {
      delete process.env.HEARTBEAT_INTERVAL_MS;
    } else {
      process.env.HEARTBEAT_INTERVAL_MS = originalHeartbeatInterval;
    }
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('does not schedule heartbeats without HEARTBEAT_URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({});
    delete process.env.HEARTBEAT_URL;
    process.env.HEARTBEAT_INTERVAL_MS = '100';
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.useFakeTimers();

    const service = new NetworkService();
    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(100);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends heartbeat requests on the configured interval and stops them on destroy', async () => {
    const fetchMock = vi.fn().mockResolvedValue({});
    process.env.HEARTBEAT_URL = 'https://heartbeat.example/ping';
    process.env.HEARTBEAT_INTERVAL_MS = '100';
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.useFakeTimers();

    const service = new NetworkService();
    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(100);

    expect(fetchMock).toHaveBeenCalledWith('https://heartbeat.example/ping', {
      method: 'GET',
    });

    fetchMock.mockClear();
    service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(100);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('swallows heartbeat failures so the timer keeps running', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    process.env.HEARTBEAT_URL = 'https://heartbeat.example/ping';
    process.env.HEARTBEAT_INTERVAL_MS = '100';
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.useFakeTimers();

    const service = new NetworkService();
    service.onModuleInit();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });
});
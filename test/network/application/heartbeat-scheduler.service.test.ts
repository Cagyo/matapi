import { describe, expect, it, vi } from 'vitest';
import { HeartbeatSchedulerService } from '../../../src/network/application/heartbeat-scheduler.service';
import type { HeartbeatClientPort } from '../../../src/network/domain/ports/heartbeat-client.port';

describe('HeartbeatSchedulerService', () => {
  it('pings the external monitor on each beat', async () => {
    const client: HeartbeatClientPort = {
      pingExternal: vi.fn().mockResolvedValue(undefined),
    };
    const service = new HeartbeatSchedulerService(client);

    await service.beat();

    expect(client.pingExternal).toHaveBeenCalledTimes(1);
  });

  it('swallows ping failures so the schedule keeps running', async () => {
    const client: HeartbeatClientPort = {
      pingExternal: vi.fn().mockRejectedValue(new Error('offline')),
    };
    const service = new HeartbeatSchedulerService(client);

    await expect(service.beat()).resolves.toBeUndefined();
    expect(client.pingExternal).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

const mockClient = {
  on: vi.fn(),
  endAsync: vi.fn().mockResolvedValue(undefined),
};

vi.mock('mqtt', () => ({ connect: vi.fn(() => mockClient) }));

import { MqttConnectionPool } from '../../../src/sensors/infrastructure/mqtt-connection.pool';

describe('MqttConnectionPool', () => {
  afterEach(() => vi.clearAllMocks());

  it('closes pooled connections through its public destroy operation', async () => {
    const pool = new MqttConnectionPool();
    await pool.acquire('mqtt://localhost:1883');

    await pool.destroyAll();

    expect(mockClient.endAsync).toHaveBeenCalledWith(true);
  });

  it('shares one destroy operation across concurrent callers', async () => {
    const pool = new MqttConnectionPool();
    await pool.acquire('mqtt://localhost:1883');

    const first = pool.destroyAll();
    const second = pool.destroyAll();

    expect(second).toBe(first);
    await first;
    expect(mockClient.endAsync).toHaveBeenCalledTimes(1);
  });
});

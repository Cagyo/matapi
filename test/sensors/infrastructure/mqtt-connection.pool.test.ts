import { describe, expect, it, vi } from 'vitest';

const mockClient = {
  on: vi.fn(),
  endAsync: vi.fn().mockResolvedValue(undefined),
};

vi.mock('mqtt', () => ({ connect: vi.fn(() => mockClient) }));

import { MqttConnectionPool } from '../../../src/sensors/infrastructure/mqtt-connection.pool';

describe('MqttConnectionPool', () => {
  it('closes pooled connections on module destroy', async () => {
    const pool = new MqttConnectionPool();
    await pool.acquire('mqtt://localhost:1883');

    await pool.onModuleDestroy();

    expect(mockClient.endAsync).toHaveBeenCalledWith(true);
  });
});

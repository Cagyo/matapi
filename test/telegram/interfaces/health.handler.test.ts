import { describe, expect, it, vi } from 'vitest';
import { SENSOR_HEALTH_PROBE_TIMEOUT_MS, SensorHealthPort } from '../../../src/sensors/application/ports/sensor-health.port';
import { SensorQueryPort } from '../../../src/sensors/domain/ports/sensor-query.port';
import { Sensor } from '../../../src/sensors/domain/sensor';
import { BotRunnerRegistry } from '../../../src/network/application/bot-runner.registry';
import { SystemHealthPort } from '../../../src/system/domain/ports/system-health.port';
import { HealthHandler } from '../../../src/telegram/interfaces/health.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import { TelegramContext } from '../../../src/telegram/interfaces/telegram-context';

function sensor(id: string): Sensor {
  return { id, name: id, type: 'digital', config: {}, enabled: true, debounceMs: 0, severity: 'info', lastValue: null, lastValueAt: null };
}

describe('HealthHandler', () => {
  it('uses the runner registry seam and counts only online probe results', async () => {
    const query: SensorQueryPort = {
      listEnabled: async () => [sensor('door'), sensor('co2')],
      listDashboardPage: async (input) => ({ sensors: [], requestedPage: input.page, page: input.page, pageCount: 0, total: 0, clamped: false }),
      findById: async () => null, findByIdIncludingArchived: async () => null, findByName: async () => null,
      listHistoryTargets: async () => ({ targets: [], page: 0, pageCount: 0 }),
    };
    const probe = vi.fn(async () => [
      { sensorId: 'door', status: 'online' as const },
      { sensorId: 'co2', status: 'failed' as const },
    ]);
    const system: SystemHealthPort = {
      collect: async () => ({ diskUsedBytes: 1, diskTotalBytes: 2, cpuTempC: null, memoryUsedBytes: 1, memoryTotalBytes: 2, uptimeSec: 1, dbSizeBytes: 1 }),
    };
    const runner = new BotRunnerRegistry();
    const handler = new HealthHandler(system, query, { probe }, runner, {} as RoleMiddleware);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler.handleCommand({ reply } as unknown as TelegramContext);

    expect(probe).toHaveBeenCalledWith(['door', 'co2'], SENSOR_HEALTH_PROBE_TIMEOUT_MS);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('Sensors: 1/2 online'));
  });
});

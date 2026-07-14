import { describe, expect, it, vi } from 'vitest';
import { SENSOR_HEALTH_PROBE_TIMEOUT_MS, SensorHealthPort } from '../../../src/sensors/application/ports/sensor-health.port';
import { SensorQueryPort } from '../../../src/sensors/domain/ports/sensor-query.port';
import { Sensor } from '../../../src/sensors/domain/sensor';
import { StatusHandler } from '../../../src/telegram/interfaces/status.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import { TelegramContext } from '../../../src/telegram/interfaces/telegram-context';

function sensor(overrides: Partial<Sensor> = {}): Sensor {
  return {
    id: 'co2',
    name: 'Living CO2',
    type: 'uart',
    config: { thresholds: { warning: 800, critical: 1200 } },
    enabled: true,
    debounceMs: 100,
    severity: 'info',
    lastValue: '1250.5',
    lastValueAt: new Date('2030-01-01T12:00:00.000Z'),
    ...overrides,
  };
}

describe('StatusHandler', () => {
  it('renders classifier-derived warning and critical UART status', async () => {
    const sensors: SensorQueryPort = {
      listEnabled: async () => [sensor()],
      listDashboardPage: async (input) => ({
        sensors: [], requestedPage: input.page, page: input.page, pageCount: 0, total: 0, clamped: false,
      }),
      findById: async () => null,
      findByIdIncludingArchived: async () => null,
      findByName: async () => null,
      listHistoryTargets: async () => ({ targets: [], page: 0, pageCount: 0 }),
    };
    const probe = vi.fn(async () => [{ sensorId: 'co2', status: 'online' as const }]);
    const health: SensorHealthPort = { probe };
    const guard = { registered: vi.fn() } as unknown as RoleMiddleware;
    const handler = new StatusHandler(sensors, health, guard);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler.handleCommand({ reply } as unknown as TelegramContext);

    expect(reply).toHaveBeenCalledWith(expect.stringContaining('1250.5 ppm ❌'));
    expect(probe).toHaveBeenCalledWith(['co2'], SENSOR_HEALTH_PROBE_TIMEOUT_MS);
  });

  it('preserves an unmarked numeric UART value when thresholds are unavailable', async () => {
    const sensors: SensorQueryPort = {
      listEnabled: async () => [sensor({ lastValue: '850', config: {} })],
      listDashboardPage: async (input) => ({
        sensors: [], requestedPage: input.page, page: input.page, pageCount: 0, total: 0, clamped: false,
      }),
      findById: async () => null,
      findByIdIncludingArchived: async () => null,
      findByName: async () => null,
      listHistoryTargets: async () => ({ targets: [], page: 0, pageCount: 0 }),
    };
    const health: SensorHealthPort = {
      probe: async () => [{ sensorId: 'co2', status: 'online' }],
    };
    const guard = { registered: vi.fn() } as unknown as RoleMiddleware;
    const handler = new StatusHandler(sensors, health, guard);
    const reply = vi.fn().mockResolvedValue(undefined);

    await handler.handleCommand({ reply } as unknown as TelegramContext);

    expect(reply).toHaveBeenCalledWith(expect.stringContaining('850 ppm'));
    expect(reply).not.toHaveBeenCalledWith(expect.stringContaining('850 ppm ✅'));
  });
});

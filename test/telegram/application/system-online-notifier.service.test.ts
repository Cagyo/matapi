import { describe, expect, it, vi } from 'vitest';
import { SystemOnlineNotifier } from '../../../src/telegram/application/system-online-notifier.service';
import { BootRecoveryService } from '../../../src/system/application/boot-recovery.service';
import { EventNotifierService } from '../../../src/events/application/event-notifier.service';
import { SensorQueryPort } from '../../../src/sensors/domain/ports/sensor-query.port';
import { Sensor } from '../../../src/sensors/domain/sensor';
import { SENSOR_HEALTH_PROBE_TIMEOUT_MS } from '../../../src/sensors/application/ports/sensor-health.port';

function makeSensor(id: string): Sensor {
  return {
    id,
    name: id,
    type: 'digital',
    config: {},
    enabled: true,
    debounceMs: 0,
    severity: 'info',
    lastValue: null,
    lastValueAt: null,
  };
}

function sensorQuery(sensors: Sensor[]): SensorQueryPort {
  return {
    listEnabled: async () => sensors,
    listDashboardPage: async (input) => ({
      sensors: [], requestedPage: input.page, page: input.page, pageCount: 0, total: 0, clamped: false,
    }),
    findById: async () => null,
    findByIdIncludingArchived: async () => null,
    findByName: async () => null,
    listHistoryTargets: async (input) => ({ targets: [], page: input.page, pageCount: 0 }),
  };
}

describe('SystemOnlineNotifier', () => {
  it('broadcasts a system-online notice with the online sensor count', async () => {
    const bootRecovery = {
      run: vi.fn(async () => ({
        dbRecovery: null,
        clockSynchronized: true,
        archiveRecovered: true,
      })),
    } as unknown as BootRecoveryService;
    const sensors = sensorQuery([makeSensor('a'), makeSensor('b')]);
    const probe = vi.fn(async () => [
      { sensorId: 'a', status: 'online' as const },
      { sensorId: 'b', status: 'offline' as const },
    ]);
    const health = { probe };
    const notify = vi.fn().mockResolvedValue(undefined);
    const notifier = { isReady: () => true, notify } as unknown as EventNotifierService;

    const service = new SystemOnlineNotifier(bootRecovery, sensors, health, notifier);
    await service.run();

    expect(notify).toHaveBeenCalledTimes(1);
    const message = notify.mock.calls[0][0] as { text: string; asFile: boolean };
    expect(message.asFile).toBe(false);
    expect(message.text).toContain('1/2 online');
    expect(probe).toHaveBeenCalledWith(['a', 'b'], SENSOR_HEALTH_PROBE_TIMEOUT_MS);
  });

  it('surfaces a database-recovery warning when one occurred', async () => {
    const bootRecovery = {
      run: vi.fn(async () => ({
        dbRecovery: 'restored_from_backup' as const,
        clockSynchronized: false,
        archiveRecovered: true,
      })),
    } as unknown as BootRecoveryService;
    const sensors = sensorQuery([]);
    const health = { probe: async () => [] };
    const notify = vi.fn().mockResolvedValue(undefined);
    const notifier = { isReady: () => true, notify } as unknown as EventNotifierService;

    const service = new SystemOnlineNotifier(bootRecovery, sensors, health, notifier);
    await service.run();

    const message = notify.mock.calls[0][0] as { text: string };
    expect(message.text).toContain('restored from local backup');
    expect(message.text).toContain('clock is not synchronized');
  });

  it('still runs boot recovery but skips the broadcast when notifier not ready', async () => {
    const run = vi.fn(async () => ({
      dbRecovery: null,
      clockSynchronized: true,
      archiveRecovered: true,
    }));
    const bootRecovery = { run } as unknown as BootRecoveryService;
    const sensors = sensorQuery([]);
    const health = { probe: async () => [] };
    const notify = vi.fn();
    const notifier = { isReady: () => false, notify } as unknown as EventNotifierService;

    const service = new SystemOnlineNotifier(bootRecovery, sensors, health, notifier);
    await service.run();

    expect(run).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('renders a healthy boot notice with no warning lines', async () => {
    const bootRecovery = {
      run: vi.fn(async () => ({
        dbRecovery: null,
        clockSynchronized: true,
        archiveRecovered: true,
      })),
    } as unknown as BootRecoveryService;
    const sensors = sensorQuery([makeSensor('a')]);
    const health = { probe: async () => [{ sensorId: 'a', status: 'online' as const }] };
    const notify = vi.fn().mockResolvedValue(undefined);
    const notifier = { isReady: () => true, notify } as unknown as EventNotifierService;

    const service = new SystemOnlineNotifier(bootRecovery, sensors, health, notifier);
    await service.run();

    const message = notify.mock.calls[0][0] as { text: string };
    const lines = message.text.split('\n');
    expect(lines.slice(0, -1)).toEqual(['🟢 System online', '🔌 Sensors: 1/1 online']);
    expect(message.text).not.toContain('⚠️');
  });

  it('still broadcasts, with an archive warning, when archive recovery failed', async () => {
    const bootRecovery = {
      run: vi.fn(async () => ({
        dbRecovery: null,
        clockSynchronized: true,
        archiveRecovered: false,
      })),
    } as unknown as BootRecoveryService;
    const sensors = sensorQuery([makeSensor('a')]);
    const health = { probe: async () => [{ sensorId: 'a', status: 'online' as const }] };
    const notify = vi.fn().mockResolvedValue(undefined);
    const notifier = { isReady: () => true, notify } as unknown as EventNotifierService;

    const service = new SystemOnlineNotifier(bootRecovery, sensors, health, notifier);
    await service.run();

    expect(notify).toHaveBeenCalledTimes(1);
    const message = notify.mock.calls[0][0] as { text: string };
    expect(message.text).toContain('1/1 online');
    expect(message.text).toContain('Archive recovery failed');
  });
});

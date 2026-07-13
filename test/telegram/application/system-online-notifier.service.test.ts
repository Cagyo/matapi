import { describe, expect, it, vi } from 'vitest';
import { SystemOnlineNotifier } from '../../../src/telegram/application/system-online-notifier.service';
import { BootRecoveryService } from '../../../src/system/application/boot-recovery.service';
import { EventNotifierService } from '../../../src/events/application/event-notifier.service';
import { SensorQueryPort } from '../../../src/sensors/domain/ports/sensor-query.port';
import { Sensor } from '../../../src/sensors/domain/sensor';

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
      run: vi.fn(async () => ({ dbRecovery: null, clockSynchronized: true })),
    } as unknown as BootRecoveryService;
    const sensors = sensorQuery([makeSensor('a'), makeSensor('b')]);
    const health = {
      probe: async () => new Map([['a', true], ['b', false]]),
    };
    const notify = vi.fn().mockResolvedValue(undefined);
    const notifier = { isReady: () => true, notify } as unknown as EventNotifierService;

    const service = new SystemOnlineNotifier(bootRecovery, sensors, health, notifier);
    await service.run();

    expect(notify).toHaveBeenCalledTimes(1);
    const message = notify.mock.calls[0][0] as { text: string; asFile: boolean };
    expect(message.asFile).toBe(false);
    expect(message.text).toContain('1/2 online');
  });

  it('surfaces a database-recovery warning when one occurred', async () => {
    const bootRecovery = {
      run: vi.fn(async () => ({
        dbRecovery: 'restored_from_backup' as const,
        clockSynchronized: false,
      })),
    } as unknown as BootRecoveryService;
    const sensors = sensorQuery([]);
    const health = { probe: async () => new Map() };
    const notify = vi.fn().mockResolvedValue(undefined);
    const notifier = { isReady: () => true, notify } as unknown as EventNotifierService;

    const service = new SystemOnlineNotifier(bootRecovery, sensors, health, notifier);
    await service.run();

    const message = notify.mock.calls[0][0] as { text: string };
    expect(message.text).toContain('restored from local backup');
    expect(message.text).toContain('clock is not synchronized');
  });

  it('still runs boot recovery but skips the broadcast when notifier not ready', async () => {
    const run = vi.fn(async () => ({ dbRecovery: null, clockSynchronized: true }));
    const bootRecovery = { run } as unknown as BootRecoveryService;
    const sensors = sensorQuery([]);
    const health = { probe: async () => new Map() };
    const notify = vi.fn();
    const notifier = { isReady: () => false, notify } as unknown as EventNotifierService;

    const service = new SystemOnlineNotifier(bootRecovery, sensors, health, notifier);
    await service.run();

    expect(run).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import { NotificationTargetDirectoryService } from '../../../src/telegram/application/notification-target-directory.service';
import { InMemoryUserSensorMuteRepository } from '../../../src/telegram/infrastructure/in-memory-user-sensor-mute.repository';

const sensor = (id: string, name: string) => ({ id, name, type: 'digital' as const, config: {}, enabled: true, debounceMs: 0, severity: 'info' as const, lastValue: null, lastValueAt: null });
const query = (sensors: ReturnType<typeof sensor>[]) => ({
  listEnabled: async () => sensors,
  listDashboardPage: async () => ({ sensors: [], requestedPage: 0, page: 0, pageCount: 0, total: 0, clamped: false }),
  findById: async (id: string) => sensors.find((value) => value.id === id) ?? null,
  findByIdIncludingArchived: async () => null,
  findByName: async (name: string) => { const value = sensors.find((item) => item.name.toLowerCase() === name.toLowerCase()); return value ? { kind: 'active' as const, sensor: value } : null; },
  listHistoryTargets: async () => ({ targets: [], page: 0, pageCount: 0 }),
});

describe('NotificationTargetDirectoryService', () => {
  it('sorts normalized target names and keeps equal sensor and camera IDs independently muted', async () => {
    const mutes = new InMemoryUserSensorMuteRepository();
    await mutes.mute(7, { kind: 'camera', id: 'same' });
    const targets = new NotificationTargetDirectoryService(
      query([sensor('same', 'Ａlpha'), sensor('sensor-2', 'z\u0000long')]),
      { listCameras: async () => [{ id: 'same', name: 'alpha', enabled: true }, { id: 'camera-2', name: 'Бета', enabled: true }] },
      mutes,
    );

    await expect(targets.listEnabled(7)).resolves.toEqual([
      { ref: { kind: 'camera', id: 'same' }, name: 'alpha', kind: 'camera', muted: true },
      { ref: { kind: 'sensor', id: 'same' }, name: 'Ａlpha', kind: 'sensor', muted: false },
      { ref: { kind: 'sensor', id: 'sensor-2' }, name: 'z\u0000long', kind: 'sensor', muted: false },
      { ref: { kind: 'camera', id: 'camera-2' }, name: 'Бета', kind: 'camera', muted: false },
    ]);
  });

  it('normalizes a legacy sensor mute once and does not return removed-target mute rows', async () => {
    const mutes = new InMemoryUserSensorMuteRepository();
    await mutes.mute(7, 'sensor-1');
    await mutes.mute(7, { kind: 'sensor', id: 'removed' });
    const targets = new NotificationTargetDirectoryService(query([sensor('sensor-1', 'Door')]), { listCameras: async () => [] }, mutes);

    await expect(targets.listEnabled(7)).resolves.toEqual([
      { ref: { kind: 'sensor', id: 'sensor-1' }, name: 'Door', kind: 'sensor', muted: true },
    ]);
    await expect(mutes.listForUser(7)).resolves.toEqual(expect.arrayContaining([{ kind: 'sensor', id: 'sensor-1' }]));
  });
});

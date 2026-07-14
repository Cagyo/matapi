import { describe, expect, it, vi } from 'vitest';
import { SENSOR_HEALTH_PROBE_TIMEOUT_MS, SensorHealthPort } from '../../../src/sensors/application/ports/sensor-health.port';
import { SensorQueryPort } from '../../../src/sensors/domain/ports/sensor-query.port';
import { Sensor } from '../../../src/sensors/domain/sensor';
import { HomeHealthSnapshot } from '../../../src/telegram/domain/home-health-snapshot';
import { HomeHealthSnapshotPort } from '../../../src/telegram/application/ports/home-health-snapshot.port';
import { RefreshHomeMonitoringUseCase } from '../../../src/telegram/application/refresh-home-monitoring.use-case';

function sensor(id: string): Sensor {
  return {
    id, name: id, type: 'digital', config: {}, enabled: true, debounceMs: 0,
    severity: 'info', lastValue: null, lastValueAt: null,
  };
}

function query(ids: string[]): SensorQueryPort {
  return {
    listEnabled: vi.fn(async () => ids.map(sensor)),
    listDashboardPage: async (input) => ({ sensors: [], requestedPage: input.page, page: input.page, pageCount: 0, total: 0, clamped: false }),
    findById: async () => null,
    findByIdIncludingArchived: async () => null,
    findByName: async () => null,
    listHistoryTargets: async () => ({ targets: [], page: 0, pageCount: 0 }),
  };
}

function prior(): HomeHealthSnapshot {
  return {
    completedAt: new Date('2029-01-01T00:00:00.000Z'), enabledSensorIds: ['prior'],
    onlineSensorIds: ['prior'], missingSensorIds: [], failedSensorIds: [], timedOutSensorIds: [], offlineSensorIds: [],
  };
}

describe('RefreshHomeMonitoringUseCase', () => {
  it('shares one in-flight refresh, partitions ordered status data, and starts again after it settles', async () => {
    let resolveProbe!: (value: readonly { sensorId: string; status: 'online' | 'offline' | 'missing' | 'failed' | 'timed_out' }[]) => void;
    const probe = vi.fn(() => new Promise<readonly { sensorId: string; status: 'online' | 'offline' | 'missing' | 'failed' | 'timed_out' }[]>((resolve) => { resolveProbe = resolve; }));
    const health = { probe } as SensorHealthPort;
    let cached: HomeHealthSnapshot | null = null;
    const snapshots: HomeHealthSnapshotPort = { get: () => cached, set: (value) => { cached = value; } };
    const useCase = new RefreshHomeMonitoringUseCase(query(['b', 'a', 'c', 'd', 'e']), health, snapshots, { now: () => new Date('2030-01-01T00:00:00.000Z') });

    const first = useCase.execute();
    const concurrent = useCase.execute();
    expect(concurrent).toBe(first);
    await Promise.resolve();
    expect(probe).toHaveBeenCalledWith(['b', 'a', 'c', 'd', 'e'], SENSOR_HEALTH_PROBE_TIMEOUT_MS);

    resolveProbe([
      { sensorId: 'b', status: 'offline' }, { sensorId: 'a', status: 'online' },
      { sensorId: 'c', status: 'missing' }, { sensorId: 'd', status: 'failed' }, { sensorId: 'e', status: 'timed_out' },
    ]);
    await expect(first).resolves.toEqual({
      kind: 'refreshed',
      snapshot: {
        completedAt: new Date('2030-01-01T00:00:00.000Z'), enabledSensorIds: ['a', 'b', 'c', 'd', 'e'],
        onlineSensorIds: ['a'], offlineSensorIds: ['b'], missingSensorIds: ['c'], failedSensorIds: ['d'], timedOutSensorIds: ['e'],
      },
    });
    expect(cached?.onlineSensorIds).toEqual(['a']);

    const later = useCase.execute();
    expect(later).not.toBe(first);
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(2);
    resolveProbe([{ sensorId: 'a', status: 'online' }]);
    await later;
  });

  it('preserves the prior snapshot when querying sensors or probing fails', async () => {
    const previous = prior();
    const snapshots: HomeHealthSnapshotPort = { get: () => previous, set: vi.fn() };
    const failedQuery = query([]);
    vi.mocked(failedQuery.listEnabled).mockRejectedValue(new Error('database unavailable'));
    const failedQueryUseCase = new RefreshHomeMonitoringUseCase(
      failedQuery,
      { probe: vi.fn() } as unknown as SensorHealthPort,
      snapshots,
      { now: () => new Date() },
    );
    await expect(failedQueryUseCase.execute()).resolves.toEqual({ kind: 'failed', previous });

    const failedProbeUseCase = new RefreshHomeMonitoringUseCase(
      query(['door']),
      { probe: vi.fn().mockRejectedValue(new Error('orchestration failed')) } as unknown as SensorHealthPort,
      snapshots,
      { now: () => new Date() },
    );
    await expect(failedProbeUseCase.execute()).resolves.toEqual({ kind: 'failed', previous });
    expect(snapshots.set).not.toHaveBeenCalled();
  });
});

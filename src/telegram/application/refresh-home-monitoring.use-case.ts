import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SENSOR_HEALTH,
  SENSOR_HEALTH_PROBE_TIMEOUT_MS,
  SensorHealthPort,
  SensorProbeResult,
} from '../../sensors/application/ports/sensor-health.port';
import {
  SENSOR_QUERY,
  SensorQueryPort,
} from '../../sensors/domain/ports/sensor-query.port';
import { CLOCK, ClockPort } from '../../events/domain/ports/clock.port';
import { HomeHealthSnapshot } from '../domain/home-health-snapshot';
import {
  HOME_HEALTH_SNAPSHOT,
  HomeHealthSnapshotPort,
} from './ports/home-health-snapshot.port';

export type RefreshHomeMonitoringResult =
  | { kind: 'refreshed'; snapshot: HomeHealthSnapshot }
  | { kind: 'failed'; previous: HomeHealthSnapshot | null };

@Injectable()
export class RefreshHomeMonitoringUseCase {
  private readonly logger = new Logger(RefreshHomeMonitoringUseCase.name);
  private inFlight: Promise<RefreshHomeMonitoringResult> | null = null;

  constructor(
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    @Inject(SENSOR_HEALTH) private readonly health: SensorHealthPort,
    @Inject(HOME_HEALTH_SNAPSHOT) private readonly snapshots: HomeHealthSnapshotPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  execute(): Promise<RefreshHomeMonitoringResult> {
    if (this.inFlight) return this.inFlight;

    let refresh!: Promise<RefreshHomeMonitoringResult>;
    refresh = this.refresh().finally(() => {
      if (this.inFlight === refresh) this.inFlight = null;
    });
    this.inFlight = refresh;
    return refresh;
  }

  private async refresh(): Promise<RefreshHomeMonitoringResult> {
    const previous = this.snapshots.get();
    try {
      const sensorIds = (await this.sensors.listEnabled()).map(({ id }) => id);
      const enabledSensorIds = [...new Set(sensorIds)];
      const probes = await this.health.probe(
        enabledSensorIds,
        SENSOR_HEALTH_PROBE_TIMEOUT_MS,
      );
      const snapshot: HomeHealthSnapshot = {
        completedAt: this.clock.now(),
        enabledSensorIds: [...enabledSensorIds].sort(),
        onlineSensorIds: this.idsFor(probes, 'online'),
        missingSensorIds: this.idsFor(probes, 'missing'),
        failedSensorIds: this.idsFor(probes, 'failed'),
        timedOutSensorIds: this.idsFor(probes, 'timed_out'),
        offlineSensorIds: this.idsFor(probes, 'offline'),
      };
      this.snapshots.set(snapshot);
      return { kind: 'refreshed', snapshot };
    } catch {
      this.logger.warn('Home monitoring refresh failed');
      return { kind: 'failed', previous };
    }
  }

  private idsFor(
    probes: readonly SensorProbeResult[],
    status: SensorProbeResult['status'],
  ): string[] {
    return probes
      .filter((probe) => probe.status === status)
      .map((probe) => probe.sensorId)
      .sort();
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { format } from 'date-fns';
import { ListCamerasUseCase } from '../../camera/application/list-cameras.use-case';
import { CLOCK, ClockPort } from '../../events/domain/ports/clock.port';
import {
  FEATURE_QUERY,
  FeatureQueryPort,
} from '../../features/domain/ports/feature-query.port';
import {
  SENSOR_QUERY,
  SensorQueryPort,
} from '../../sensors/domain/ports/sensor-query.port';
import { ConfigSnapshot } from '../domain/config-snapshot';
import {
  CONFIG_CODEC,
  ConfigCodecPort,
} from '../domain/ports/config-codec.port';

export interface ExportedConfig {
  yaml: string;
  filename: string;
}

/**
 * Spec 16 § /export_config. Snapshots the active sensors, configured cameras,
 * and feature flags into a single YAML document for download.
 */
@Injectable()
export class ExportConfigUseCase {
  constructor(
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    private readonly cameras: ListCamerasUseCase,
    @Inject(FEATURE_QUERY) private readonly features: FeatureQueryPort,
    @Inject(CONFIG_CODEC) private readonly codec: ConfigCodecPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(): Promise<ExportedConfig> {
    const [sensorRows, cameraRows, featureRows] = await Promise.all([
      this.sensors.listEnabled(),
      this.cameras.execute(),
      this.features.listAll(),
    ]);

    const snapshot: ConfigSnapshot = {
      sensors: sensorRows.map((s) => ({
        name: s.name,
        type: s.type,
        config: s.config,
        debounce_ms: s.debounceMs,
        severity: s.severity,
      })),
      cameras: cameraRows.map((c) => ({
        name: c.name,
        type: c.type,
        config: c.config,
      })),
      features: featureRows.map((f) => ({
        name: f.name,
        enabled: f.enabled,
      })),
    };

    return {
      yaml: this.codec.serialize(snapshot),
      filename: `home-worker-config-${format(this.clock.now(), 'yyyy-MM-dd')}.yml`,
    };
  }
}

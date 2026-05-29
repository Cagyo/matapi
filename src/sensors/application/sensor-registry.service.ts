import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SensorEventSourcePort } from '../../events/domain/ports/sensor-event-source.port';
import {
  SENSOR_DRIVER_FACTORY,
  SensorDriverFactory,
  SensorDriverPort,
} from '../domain/ports/sensor-driver.port';
import { SensorHealthPort } from './ports/sensor-health.port';
import {
  SENSOR_REPOSITORY,
  SensorRepositoryPort,
} from '../domain/ports/sensor-repository.port';
import { SensorEvent } from '../domain/sensor-event';

/**
 * Application-tier coordinator for the live sensor pipeline.
 *
 * - Loads enabled sensors via `SensorRepositoryPort`.
 * - Constructs drivers via the injected `SensorDriverFactory`.
 * - Persists `lastValue` / `lastValueAt` for `/status` consumers.
 * - Implements `SensorEventSourcePort` so `events/` can subscribe without
 *   knowing about Drizzle or specific adapters.
 */
@Injectable()
export class SensorRegistryService
  implements SensorEventSourcePort, SensorHealthPort, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SensorRegistryService.name);
  private readonly active = new Map<string, SensorDriverPort>();
  private readonly listeners: ((event: SensorEvent) => void)[] = [];

  constructor(
    @Inject(SENSOR_REPOSITORY)
    private readonly repository: SensorRepositoryPort,
    @Inject(SENSOR_DRIVER_FACTORY)
    private readonly driverFactory: SensorDriverFactory,
  ) {}

  onEvent(callback: (event: SensorEvent) => void): void {
    this.listeners.push(callback);
  }

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  async onModuleDestroy(): Promise<void> {
    for (const driver of this.active.values()) {
      try {
        await driver.destroy();
      } catch (err) {
        this.logger.warn(`Driver destroy failed: ${(err as Error).message}`);
      }
    }
    this.active.clear();
  }

  /** Sync in-memory drivers to the repository's enabled set. */
  async reload(): Promise<void> {
    const wanted = await this.repository.loadEnabled();
    const wantedIds = new Set(wanted.map((s) => s.id));

    for (const id of [...this.active.keys()]) {
      if (!wantedIds.has(id)) {
        await this.active.get(id)?.destroy().catch(() => undefined);
        this.active.delete(id);
      }
    }

    // Digital pin uniqueness — first sensor wins, subsequent skipped + logged.
    const pinOwners = new Map<number, string>();
    for (const sensor of wanted) {
      if (sensor.type !== 'digital') continue;
      const pin = extractPin(sensor.config);
      if (pin === null) continue;
      const prior = pinOwners.get(pin);
      if (prior) {
        this.logger.error(
          `GPIO pin ${pin} is already used by sensor '${prior}' — skipping '${sensor.name}'`,
        );
        continue;
      }
      pinOwners.set(pin, sensor.name);
    }

    for (const sensor of wanted) {
      if (this.active.has(sensor.id)) continue;
      if (sensor.type === 'digital') {
        const pin = extractPin(sensor.config);
        if (pin !== null && pinOwners.get(pin) !== sensor.name) continue;
      }

      const driver = this.driverFactory(sensor.type);
      try {
        await driver.init({
          id: sensor.id,
          name: sensor.name,
          type: sensor.type,
          config: sensor.config,
          debounceMs: sensor.debounceMs,
          severity: sensor.severity,
        });
        driver.onEvent((event) => this.fanOut(event));
        this.active.set(sensor.id, driver);
      } catch (err) {
        this.logger.error(`Failed to init "${sensor.name}": ${(err as Error).message}`);
      }
    }
  }

  getDriver(id: string): SensorDriverPort | undefined {
    return this.active.get(id);
  }

  list(): { id: string; driver: SensorDriverPort }[] {
    return [...this.active.entries()].map(([id, driver]) => ({ id, driver }));
  }

  /** `SensorHealthPort.probe` — exposes live driver health to consumers. */
  async probe(): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    for (const [id, driver] of this.active.entries()) {
      try {
        result.set(id, await driver.healthCheck());
      } catch (err) {
        this.logger.warn(
          `healthCheck failed for ${id}: ${(err as Error).message}`,
        );
        result.set(id, false);
      }
    }
    return result;
  }

  private fanOut(event: SensorEvent): void {
    void this.persistState(event);
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch (err) {
        this.logger.error(`Listener error: ${(err as Error).message}`);
      }
    }
  }

  private async persistState(event: SensorEvent): Promise<void> {
    if (event.type === 'error') return;
    try {
      await this.repository.updateState(
        event.sensorId,
        String(event.newValue),
        event.timestamp,
      );
    } catch (err) {
      this.logger.warn(
        `persistState failed for ${event.sensorId}: ${(err as Error).message}`,
      );
    }
  }
}

function extractPin(rawConfig: Record<string, unknown> | null | undefined): number | null {
  const pin = rawConfig?.pin;
  return typeof pin === 'number' ? pin : null;
}

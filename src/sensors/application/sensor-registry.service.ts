import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { SensorEventSourcePort } from '../../events/domain/ports/sensor-event-source.port';
import {
  SENSOR_DRIVER_FACTORY,
  SensorDriverFactory,
  SensorDriverPort,
  SensorDriverShutdownContext,
} from '../domain/ports/sensor-driver.port';
import { SensorHealthPort } from './ports/sensor-health.port';
import {
  SENSOR_REPOSITORY,
  SensorRepositoryPort,
} from '../domain/ports/sensor-repository.port';
import { SensorEvent } from '../domain/sensor-event';
import { DriverUnavailableError } from '../domain/errors/driver-unavailable.error';

const DRIVER_SHUTDOWN_TIMEOUT_MS = 5_000;

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
  implements SensorEventSourcePort, SensorHealthPort, OnModuleInit
{
  private readonly logger = new Logger(SensorRegistryService.name);
  private readonly active = new Map<string, SensorDriverPort>();
  private readonly listeners: ((event: SensorEvent) => void)[] = [];
  private reloadChain: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    @Inject(SENSOR_REPOSITORY)
    private readonly repository: SensorRepositoryPort,
    @Inject(SENSOR_DRIVER_FACTORY)
    private readonly driverFactory: SensorDriverFactory,
  ) {}

  onEvent(callback: (event: SensorEvent) => void): void {
    if (this.shuttingDown) return;
    this.listeners.push(callback);
  }

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.shuttingDown = true;
    this.listeners.length = 0;
    this.shutdownPromise = this.destroyDrivers();
    return this.shutdownPromise;
  }

  private async destroyDrivers(): Promise<void> {
    try {
      await this.reloadChain;
    } catch {
      this.logger.warn('Sensor reload failed before shutdown');
    }

    for (const driver of this.active.values()) {
      try {
        await this.destroyDriver(driver);
      } catch {
        this.logger.warn('Driver destroy failed during shutdown');
      }
    }
    this.active.clear();
  }

  /**
   * The registry deliberately awaits the driver's own bounded teardown rather
   * than racing it here. This preserves driver-before-gateway ordering while
   * making cancellation a port-level responsibility for each adapter.
   */
  private async destroyDriver(driver: SensorDriverPort): Promise<void> {
    const controller = new AbortController();
    const deadlineAt = Date.now() + DRIVER_SHUTDOWN_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), DRIVER_SHUTDOWN_TIMEOUT_MS);
    timeout.unref?.();
    const context: SensorDriverShutdownContext = { signal: controller.signal, deadlineAt };
    try {
      await driver.destroy(context);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Public entry point — serialized so overlapping callers never interleave. */
  async reload(): Promise<void> {
    if (this.shuttingDown) return;
    this.reloadChain = this.reloadChain.then(
      () => this.doReload(),
      () => this.doReload(),
    );
    return this.reloadChain;
  }

  /** Sync in-memory drivers to the repository's enabled set. */
  private async doReload(): Promise<void> {
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
        if (err instanceof DriverUnavailableError) {
          driver.onEvent((event) => this.fanOut(event));
          this.active.set(sensor.id, driver);
          this.logger.warn(
            `Driver for "${sensor.name}" is offline and will recover when available`,
          );
          continue;
        }
        this.logger.error(`Failed to init "${sensor.name}"`);
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
      } catch {
        this.logger.warn(`healthCheck failed for ${id}`);
        result.set(id, false);
      }
    }
    return result;
  }

  private fanOut(event: SensorEvent): void {
    if (this.shuttingDown) return;
    void this.persistState(event);
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {
        this.logger.error('Sensor event listener failed');
      }
    }
  }

  private async persistState(event: SensorEvent): Promise<void> {
    if (this.shuttingDown) return;
    if (event.type === 'error') return;
    try {
      await this.repository.updateState(
        event.sensorId,
        String(event.newValue),
        event.timestamp,
      );
    } catch {
      this.logger.warn(`persistState failed for ${event.sensorId}`);
    }
  }
}

function extractPin(rawConfig: Record<string, unknown> | null | undefined): number | null {
  const pin = rawConfig?.pin;
  return typeof pin === 'number' ? pin : null;
}

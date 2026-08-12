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
import {
  SensorHealthPort,
  SensorProbeResult,
  SensorProbeStatus,
} from './ports/sensor-health.port';
import {
  SENSOR_REPOSITORY,
  SensorRepositoryPort,
} from '../domain/ports/sensor-repository.port';
import { Sensor, SensorType } from '../domain/sensor';
import { SensorEvent } from '../domain/sensor-event';
import { DriverUnavailableError } from '../domain/errors/driver-unavailable.error';
import { isValidPpm } from '../domain/co2';
import {
  FEATURE_AVAILABILITY,
  type FeatureAvailabilityPort,
} from '../../features/domain/ports/feature-availability.port';
import { FeatureUnavailableError } from '../../features/domain/errors/feature-unavailable.error';
import type { ManageableFeatureName } from '../../features/domain/manageable-feature';
import { featureForSensorType } from './feature-for-sensor-type';

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
  private readonly activeTypes = new Map<string, SensorType>();
  private readonly activeConfigKeys = new Map<string, string>();
  private readonly activeHealthChecks = new Map<string, Promise<boolean>>();
  private readonly listeners: ((event: SensorEvent) => void)[] = [];
  private readonly blockedFeatures = new Set<ManageableFeatureName>();
  private reloadChain: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    @Inject(SENSOR_REPOSITORY)
    private readonly repository: SensorRepositoryPort,
    @Inject(SENSOR_DRIVER_FACTORY)
    private readonly driverFactory: SensorDriverFactory,
    @Inject(FEATURE_AVAILABILITY)
    private readonly availability: FeatureAvailabilityPort = alwaysAvailable,
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
    this.activeTypes.clear();
    this.activeHealthChecks.clear();
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

  /** Prevent recreation synchronously, then detach and tear down its drivers. */
  stopFeature(name: ManageableFeatureName): Promise<void> {
    this.blockedFeatures.add(name);
    if (this.shuttingDown) return Promise.resolve();
    this.reloadChain = this.reloadChain.then(
      () => this.stopFeatureDrivers(name),
      () => this.stopFeatureDrivers(name),
    );
    return this.reloadChain;
  }

  /** Enables a previously stopped runtime and reloads its persisted sensors. */
  resumeFeature(name: ManageableFeatureName): Promise<void> {
    this.blockedFeatures.delete(name);
    return this.reload();
  }

  /** Sync in-memory drivers to the repository's enabled set. */
  private async doReload(): Promise<void> {
    await this.availability.awaitInitialVerification();
    const wanted = await this.repository.loadEnabled();
    const eligibility = await this.eligibleFeatures(wanted);
    const eligibleWanted = wanted.filter((sensor) => this.isEligible(sensor, eligibility));
    const wantedIds = new Set(eligibleWanted.map((s) => s.id));

    for (const id of [...this.active.keys()]) {
      if (!wantedIds.has(id)) {
        await this.detachAndDestroy(id);
      }
    }

    // A driver holds a snapshot of the sensor configuration from `init`.
    // Replace it when a config edit changes that snapshot (e.g. GPIO pin),
    // otherwise `/config modify` would only take effect after a process restart.
    for (const sensor of eligibleWanted) {
      if (
        this.active.has(sensor.id) &&
        this.activeConfigKeys.get(sensor.id) !== driverConfigKey(sensor)
      ) {
        await this.detachAndDestroy(sensor.id);
      }
    }

    // Digital pin uniqueness — first sensor wins, subsequent skipped + logged.
    const pinOwners = new Map<number, string>();
    for (const sensor of eligibleWanted) {
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

    for (const sensor of eligibleWanted) {
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
        driver.onEvent((event) => void this.fanOut(driver, event));
        this.active.set(sensor.id, driver);
        this.activeTypes.set(sensor.id, sensor.type);
        this.activeConfigKeys.set(sensor.id, driverConfigKey(sensor));
      } catch (err) {
        if (err instanceof DriverUnavailableError) {
          driver.onEvent((event) => void this.fanOut(driver, event));
          this.active.set(sensor.id, driver);
          this.activeTypes.set(sensor.id, sensor.type);
          this.activeConfigKeys.set(sensor.id, driverConfigKey(sensor));
          this.logger.warn(
            `Driver for "${sensor.name}" is offline and will recover when available`,
          );
          continue;
        }
        this.logger.error(`Failed to init "${sensor.name}"`);
      }
    }
  }

  private async eligibleFeatures(sensors: readonly Sensor[]): Promise<Map<ManageableFeatureName, boolean>> {
    const features = new Set<ManageableFeatureName>();
    for (const sensor of sensors) {
      const feature = featureForSensorType(sensor.type);
      if (feature) features.add(feature);
    }
    const entries = await Promise.all([...features].map(async (feature) => [
      feature,
      !this.blockedFeatures.has(feature) && await this.isFeatureReady(feature),
    ] as const));
    return new Map(entries);
  }

  private isEligible(sensor: Sensor, eligibility: ReadonlyMap<ManageableFeatureName, boolean>): boolean {
    const feature = featureForSensorType(sensor.type);
    return feature === null || eligibility.get(feature) === true;
  }

  private async isFeatureReady(name: ManageableFeatureName): Promise<boolean> {
    try {
      await this.availability.requireReady(name);
      return true;
    } catch (error) {
      if (error instanceof FeatureUnavailableError) return false;
      throw error;
    }
  }

  private async stopFeatureDrivers(name: ManageableFeatureName): Promise<void> {
    for (const [id, type] of [...this.activeTypes.entries()]) {
      if (featureForSensorType(type) === name) await this.detachAndDestroy(id);
    }
  }

  private async detachAndDestroy(id: string): Promise<void> {
    const driver = this.active.get(id);
    this.active.delete(id);
    this.activeTypes.delete(id);
    this.activeConfigKeys.delete(id);
    this.activeHealthChecks.delete(id);
    if (!driver) return;
    try {
      await this.destroyDriver(driver);
    } catch {
      this.logger.warn('Driver destroy failed during reload');
    }
  }

  getDriver(id: string): SensorDriverPort | undefined {
    return this.active.get(id);
  }

  list(): { id: string; driver: SensorDriverPort }[] {
    return [...this.active.entries()].map(([id, driver]) => ({ id, driver }));
  }

  /** `SensorHealthPort.probe` — bounded concurrent live-driver probing. */
  probe(
    sensorIds: readonly string[],
    timeoutMs: number,
  ): Promise<readonly SensorProbeResult[]> {
    return Promise.all(sensorIds.map((sensorId) => this.probeDriver(sensorId, timeoutMs)));
  }

  private probeDriver(sensorId: string, timeoutMs: number): Promise<SensorProbeResult> {
    const driver = this.active.get(sensorId);
    if (!driver) return Promise.resolve({ sensorId, status: 'missing' });

    const healthCheck = this.activeHealthCheck(sensorId, driver);
    return new Promise((resolve) => {
      let finished = false;
      const finish = (status: SensorProbeStatus) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        resolve({ sensorId, status });
      };
      const timeout = setTimeout(() => finish('timed_out'), timeoutMs);
      timeout.unref?.();

      void healthCheck.then(
        (online) => finish(online ? 'online' : 'offline'),
        () => {
          this.logger.warn(`healthCheck failed for ${sensorId}`);
          finish('failed');
        },
      );
    });
  }

  private activeHealthCheck(sensorId: string, driver: SensorDriverPort): Promise<boolean> {
    const existing = this.activeHealthChecks.get(sensorId);
    if (existing) return existing;

    const check = Promise.resolve()
      .then(() => driver.healthCheck())
      .finally(() => {
        if (this.activeHealthChecks.get(sensorId) === check) {
          this.activeHealthChecks.delete(sensorId);
        }
      });
    this.activeHealthChecks.set(sensorId, check);
    return check;
  }

  private async fanOut(source: SensorDriverPort, event: SensorEvent): Promise<void> {
    const type = this.activeTypes.get(event.sensorId);
    const feature = type ? featureForSensorType(type) : null;
    if (feature && !await this.isFeatureReady(feature)) return;
    if (!this.isCurrentEventSource(source, event.sensorId, feature)) return;
    await this.persistState(event);
    if (feature && !await this.isFeatureReady(feature)) return;
    if (!this.isCurrentEventSource(source, event.sensorId, feature)) return;
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {
        this.logger.error('Sensor event listener failed');
      }
    }
  }

  private isCurrentEventSource(
    source: SensorDriverPort,
    sensorId: string,
    feature: ManageableFeatureName | null,
  ): boolean {
    return !this.shuttingDown
      && this.active.get(sensorId) === source
      && (feature === null || !this.blockedFeatures.has(feature));
  }

  private async persistState(event: SensorEvent): Promise<void> {
    if (this.shuttingDown) return;
    if (event.type === 'error') return;
    try {
      const value = this.persistedStateValue(event);
      if (value === null) return;
      await this.repository.updateState(
        event.sensorId,
        value,
        event.timestamp,
      );
    } catch {
      this.logger.warn(`persistState failed for ${event.sensorId}`);
    }
  }

  private persistedStateValue(event: SensorEvent): string | null {
    if (this.activeTypes.get(event.sensorId) !== 'uart') return String(event.newValue);

    const ppm = this.active.get(event.sensorId)?.getState().value;
    return typeof ppm === 'number' && isValidPpm(ppm) ? String(ppm) : null;
  }
}

const alwaysAvailable: FeatureAvailabilityPort = {
  awaitInitialVerification: async () => undefined,
  inspect: async () => {
    throw new Error('Feature availability is unavailable');
  },
  requireReady: async () => undefined,
};

function extractPin(rawConfig: Record<string, unknown> | null | undefined): number | null {
  const pin = rawConfig?.pin;
  return typeof pin === 'number' ? pin : null;
}

function driverConfigKey(sensor: Sensor): string {
  return JSON.stringify([
    sensor.name,
    sensor.type,
    sensor.config,
    sensor.debounceMs,
    sensor.severity,
  ]);
}

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, AppDatabase } from '../database/database.module';
import { sensors } from '../database/schema';
import { ISensorDriver, SensorConfig, SensorEvent } from './sensor.interface';
import { MockGpioDriver } from './drivers/mock.driver';
import { DigitalDriver } from './drivers/digital.driver';
import { UartDriver } from './drivers/uart.driver';
import { MqttDriver } from './drivers/mqtt.driver';
import { CameraDriver } from './drivers/camera.driver';

type DriverFactory = () => ISensorDriver;

@Injectable()
export class SensorRegistry implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SensorRegistry.name);
  private readonly active = new Map<string, ISensorDriver>();
  private readonly listeners: Array<(event: SensorEvent) => void> = [];
  private readonly factories: Record<string, DriverFactory>;

  constructor(@Inject(DB) private readonly db: AppDatabase) {
    const isDev = process.env.NODE_ENV === 'development';
    this.factories = {
      digital: () => (isDev ? new MockGpioDriver() : new DigitalDriver()),
      uart: () => new UartDriver(),
      mqtt: () => new MqttDriver(),
      camera: () => new CameraDriver(),
    };
  }

  onEvent(cb: (event: SensorEvent) => void): void {
    this.listeners.push(cb);
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

  /** Sync in-memory drivers to the `sensors` table. */
  async reload(): Promise<void> {
    const rows = this.db.select().from(sensors).where(eq(sensors.enabled, true)).all();

    const wantIds = new Set(rows.map((r) => r.id));
    for (const id of [...this.active.keys()]) {
      if (!wantIds.has(id)) {
        await this.active.get(id)?.destroy().catch(() => undefined);
        this.active.delete(id);
      }
    }

    for (const row of rows) {
      if (this.active.has(row.id)) continue;

      const factory = this.factories[row.type];
      if (!factory) {
        this.logger.warn(`Unknown sensor type "${row.type}" for ${row.name}`);
        continue;
      }

      const driver = factory();
      const config: SensorConfig = {
        id: row.id,
        name: row.name,
        type: row.type as SensorConfig['type'],
        config: (row.config as Record<string, any>) ?? {},
        debounceMs: row.debounceMs ?? 10000,
        severity: (row.severity as SensorConfig['severity']) ?? 'info',
      };

      try {
        await driver.init(config);
        driver.onEvent((event) => this.fanOut(event));
        this.active.set(row.id, driver);
      } catch (err) {
        this.logger.error(`Failed to init "${row.name}": ${(err as Error).message}`);
      }
    }
  }

  getDriver(id: string): ISensorDriver | undefined {
    return this.active.get(id);
  }

  list(): Array<{ id: string; driver: ISensorDriver }> {
    return [...this.active.entries()].map(([id, driver]) => ({ id, driver }));
  }

  private fanOut(event: SensorEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch (err) {
        this.logger.error(`Listener error: ${(err as Error).message}`);
      }
    }
  }
}

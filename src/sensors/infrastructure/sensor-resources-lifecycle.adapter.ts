import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { SensorRegistryService } from '../application/sensor-registry.service';
import { GPIO_BACKEND, type GpioBackendPort } from './gpio-backend.port';
import { MqttConnectionPool } from './mqtt-connection.pool';

/** Owns the ordered shutdown of sensor drivers and their shared gateways. */
@Injectable()
export class SensorResourcesLifecycleAdapter implements OnModuleDestroy {
  private readonly logger = new Logger(SensorResourcesLifecycleAdapter.name);
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    @Inject(SensorRegistryService)
    private readonly registry: SensorRegistryService,
    @Inject(GPIO_BACKEND)
    private readonly gpioBackend: GpioBackendPort,
    @Inject(MqttConnectionPool)
    private readonly mqtt: MqttConnectionPool,
  ) {}

  onModuleDestroy(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.shutdownResources();
    return this.shutdownPromise;
  }

  private async shutdownResources(): Promise<void> {
    this.mqtt.beginLifecycleShutdown();
    await this.registry.shutdown();
    const results = await Promise.allSettled([
      this.gpioBackend.close(),
      this.mqtt.destroyAll(),
    ]);

    const resources = ['GPIO backend', 'MQTT connection pool'];
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        this.logger.warn(`${resources[index]} close failed`);
      }
    }
  }
}

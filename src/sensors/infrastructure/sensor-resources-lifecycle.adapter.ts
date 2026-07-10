import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { SensorRegistryService } from '../application/sensor-registry.service';
import { MqttConnectionPool } from './mqtt-connection.pool';
import { PigpioGateway } from './pigpio.gateway';

/** Owns the ordered shutdown of sensor drivers and their shared gateways. */
@Injectable()
export class SensorResourcesLifecycleAdapter implements OnModuleDestroy {
  private readonly logger = new Logger(SensorResourcesLifecycleAdapter.name);
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly registry: SensorRegistryService,
    private readonly pigpio: PigpioGateway,
    private readonly mqtt: MqttConnectionPool,
  ) {}

  onModuleDestroy(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.shutdownResources();
    return this.shutdownPromise;
  }

  private async shutdownResources(): Promise<void> {
    await this.registry.shutdown();
    const results = await Promise.allSettled([
      this.pigpio.close(),
      this.mqtt.destroyAll(),
    ]);

    const resources = ['Pigpio gateway', 'MQTT connection pool'];
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        this.logger.warn(`${resources[index]} close failed`);
      }
    }
  }
}

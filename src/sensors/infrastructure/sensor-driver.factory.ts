import { Injectable } from '@nestjs/common';
import { SensorDriverFactory, SensorDriverPort } from '../domain/ports/sensor-driver.port';
import { SensorLogRepositoryPort } from '../domain/ports/sensor-log-repository.port';
import { SensorType } from '../domain/sensor';
import { CameraSensorAdapter } from './camera-sensor.adapter';
import { DigitalGpioAdapter } from './digital-gpio.adapter';
import { MockGpioAdapter } from './mock-gpio.adapter';
import { MockUartCo2Adapter } from './mock-uart-co2.adapter';
import { MqttSensorAdapter } from './mqtt-sensor.adapter';
import { PigpioGateway } from './pigpio.gateway';
import { UartCo2Adapter } from './uart-co2.adapter';

export interface SensorDriverFactoryDeps {
  pigpio: PigpioGateway;
  sensorLogs: SensorLogRepositoryPort;
}

/**
 * Build the env-driven driver factory.
 *
 * - NODE_ENV=development  →  digital/uart use in-memory mocks.
 * - otherwise              →  digital uses pigpiod, uart uses serialport.
 *
 * MQTT and camera adapters are still phase-1 stubs in both modes.
 */
@Injectable()
export class SensorDriverFactoryProvider {
  static build({ pigpio, sensorLogs }: SensorDriverFactoryDeps): SensorDriverFactory {
    const isDev = process.env.NODE_ENV === 'development';
    return (type: SensorType): SensorDriverPort => {
      switch (type) {
        case 'digital':
          return isDev ? new MockGpioAdapter() : new DigitalGpioAdapter(pigpio);
        case 'uart':
          return isDev
            ? new MockUartCo2Adapter(sensorLogs)
            : new UartCo2Adapter(sensorLogs);
        case 'mqtt':
          return new MqttSensorAdapter();
        case 'camera':
          return new CameraSensorAdapter();
      }
    };
  }
}

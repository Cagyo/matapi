import { Injectable } from '@nestjs/common';
import { SensorDriverFactory, SensorDriverPort } from '../domain/ports/sensor-driver.port';
import { SensorLogRepositoryPort } from '../domain/ports/sensor-log-repository.port';
import { SensorType } from '../domain/sensor';
import { CameraSensorAdapter } from './camera-sensor.adapter';
import { DigitalGpioAdapter } from './digital-gpio.adapter';
import { MockCameraAdapter } from './mock-camera.adapter';
import { MockGpioAdapter } from './mock-gpio.adapter';
import { MockMqttAdapter } from './mock-mqtt.adapter';
import { MockUartCo2Adapter } from './mock-uart-co2.adapter';
import { MqttConnectionPool } from './mqtt-connection.pool';
import { MqttSensorAdapter } from './mqtt-sensor.adapter';
import { PigpioGateway } from './pigpio.gateway';
import { UartCo2Adapter } from './uart-co2.adapter';

export interface SensorDriverFactoryDeps {
  pigpio: PigpioGateway;
  sensorLogs: SensorLogRepositoryPort;
  mqttPool: MqttConnectionPool;
}

/**
 * Build the env-driven driver factory.
 *
 * - NODE_ENV=development  →  digital/uart/mqtt/camera use in-memory mocks.
 * - otherwise              →  production hardware and protocol adapters.
 */
@Injectable()
export class SensorDriverFactoryProvider {
  static build({ pigpio, sensorLogs, mqttPool }: SensorDriverFactoryDeps): SensorDriverFactory {
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
          return isDev ? new MockMqttAdapter() : new MqttSensorAdapter(mqttPool);
        case 'camera':
          return isDev ? new MockCameraAdapter() : new CameraSensorAdapter();
      }
    };
  }
}

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
import { GpioBackendPort } from './gpio-backend.port';
import { MqttConnectionPool } from './mqtt-connection.pool';
import { MqttSensorAdapter } from './mqtt-sensor.adapter';
import { UartCo2Adapter } from './uart-co2.adapter';

export interface SensorDriverFactoryDeps {
  gpioBackend: GpioBackendPort;
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
  static build({ gpioBackend, sensorLogs, mqttPool }: SensorDriverFactoryDeps): SensorDriverFactory {
    const isDev =
      process.env.NODE_ENV === 'development' ||
      process.env.NODE_ENV === 'test' ||
      process.env.SENSOR_MODE === 'stub';
    return (type: SensorType): SensorDriverPort => {
      switch (type) {
        case 'digital':
          return isDev
            ? new MockGpioAdapter(sensorLogs)
            : new DigitalGpioAdapter(gpioBackend, sensorLogs);
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

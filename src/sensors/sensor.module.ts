import { Module } from '@nestjs/common';
import { CLOCK } from '../events/domain/ports/clock.port';
import { SystemClockAdapter } from '../events/infrastructure/system-clock.adapter';
import { AddSensorUseCase } from './application/add-sensor.use-case';
import { ModifySensorUseCase } from './application/modify-sensor.use-case';
import { ReloadSensorsUseCase } from './application/reload-sensors.use-case';
import { RemoveSensorUseCase } from './application/remove-sensor.use-case';
import { SensorRegistryService } from './application/sensor-registry.service';
import { SENSOR_HEALTH } from './application/ports/sensor-health.port';
import {
  SENSOR_DRIVER_FACTORY,
  SensorDriverFactory,
} from './domain/ports/sensor-driver.port';
import {
  SENSOR_LOG_REPOSITORY,
  SensorLogRepositoryPort,
} from './domain/ports/sensor-log-repository.port';
import { SENSOR_QUERY } from './domain/ports/sensor-query.port';
import { SENSOR_REPOSITORY } from './domain/ports/sensor-repository.port';
import { DrizzleSensorLogRepository } from './infrastructure/drizzle-sensor-log.repository';
import { DrizzleSensorQuery } from './infrastructure/drizzle-sensor.query';
import { DrizzleSensorRepository } from './infrastructure/drizzle-sensor.repository';
import { PigpioGateway } from './infrastructure/pigpio.gateway';
import { SensorDriverFactoryProvider } from './infrastructure/sensor-driver.factory';

@Module({
  providers: [
    SensorRegistryService,
    ReloadSensorsUseCase,
    AddSensorUseCase,
    ModifySensorUseCase,
    RemoveSensorUseCase,
    PigpioGateway,
    { provide: CLOCK, useClass: SystemClockAdapter },
    { provide: SENSOR_REPOSITORY, useClass: DrizzleSensorRepository },
    { provide: SENSOR_LOG_REPOSITORY, useClass: DrizzleSensorLogRepository },
    { provide: SENSOR_QUERY, useClass: DrizzleSensorQuery },
    { provide: SENSOR_HEALTH, useExisting: SensorRegistryService },
    {
      provide: SENSOR_DRIVER_FACTORY,
      useFactory: (
        pigpio: PigpioGateway,
        sensorLogs: SensorLogRepositoryPort,
      ): SensorDriverFactory =>
        SensorDriverFactoryProvider.build({ pigpio, sensorLogs }),
      inject: [PigpioGateway, SENSOR_LOG_REPOSITORY],
    },
  ],
  exports: [
    SensorRegistryService,
    ReloadSensorsUseCase,
    AddSensorUseCase,
    ModifySensorUseCase,
    RemoveSensorUseCase,
    PigpioGateway,
    SENSOR_REPOSITORY,
    SENSOR_LOG_REPOSITORY,
    SENSOR_QUERY,
    SENSOR_HEALTH,
    SENSOR_DRIVER_FACTORY,
  ],
})
export class SensorModule {}

import { Module } from '@nestjs/common';
import { FeatureModule } from '../features/feature.module';
import { FEATURE_RUNTIME_LIFECYCLE, type FeatureRuntimeLifecycleRegistryPort } from '../features/domain/ports/feature-runtime-lifecycle.port';
import { CLOCK } from '../events/domain/ports/clock.port';
import { SystemClockAdapter } from '../events/infrastructure/system-clock.adapter';
import { AddSensorUseCase } from './application/add-sensor.use-case';
import { DevSeederService } from './application/dev-seeder.service';
import { ImportSensorsUseCase } from './application/import-sensors.use-case';
import { ListSensorHistoryTargetsUseCase } from './application/list-sensor-history-targets.use-case';
import { ModifySensorUseCase } from './application/modify-sensor.use-case';
import { ReloadSensorsUseCase } from './application/reload-sensors.use-case';
import { RemoveSensorUseCase } from './application/remove-sensor.use-case';
import { SensorRegistryService } from './application/sensor-registry.service';
import { FeatureSensorRuntimeLifecycleService } from './application/feature-sensor-runtime-lifecycle.service';
import { SimulateSensorUseCase } from './application/simulate-sensor.use-case';
import { ReadSensorLogHistoryUseCase } from './application/read-sensor-log-history.use-case';
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
import { SENSOR_LOG_EXPORT_READER } from './domain/ports/sensor-log-export-reader.port';
import { SENSOR_REPOSITORY } from './domain/ports/sensor-repository.port';
import { DrizzleSensorLogRepository } from './infrastructure/drizzle-sensor-log.repository';
import { DrizzleSensorLogExportReader } from './infrastructure/drizzle-sensor-log-export.reader';
import { DrizzleSensorQuery } from './infrastructure/drizzle-sensor.query';
import { DrizzleSensorRepository } from './infrastructure/drizzle-sensor.repository';
import { GPIO_BACKEND, type GpioBackendPort } from './infrastructure/gpio-backend.port';
import { LibgpiodCliBackend } from './infrastructure/libgpiod-cli.backend';
import { MqttConnectionPool } from './infrastructure/mqtt-connection.pool';
import { SensorResourcesLifecycleAdapter } from './infrastructure/sensor-resources-lifecycle.adapter';
import { SensorDriverFactoryProvider } from './infrastructure/sensor-driver.factory';
import { DevSimulatorController } from './interfaces/dev-simulator.controller';

// The dev simulator panel (spec 26) is mounted on the worker's loopback HTTP
// server only in development — never reachable in production.
const devControllers =
  process.env.NODE_ENV === 'development' ? [DevSimulatorController] : [];

@Module({
  imports: [FeatureModule],
  controllers: devControllers,
  providers: [
    DevSeederService,
    SensorRegistryService,
    {
      provide: FeatureSensorRuntimeLifecycleService,
      useFactory: (
        lifecycleRegistry: FeatureRuntimeLifecycleRegistryPort,
        registry: SensorRegistryService,
      ) => {
        const lifecycle = new FeatureSensorRuntimeLifecycleService(registry);
        lifecycleRegistry.register('digital', lifecycle.forFeature('digital'));
        lifecycleRegistry.register('uart', lifecycle.forFeature('uart'));
        lifecycleRegistry.register('zigbee', lifecycle.forFeature('zigbee'));
        return lifecycle;
      },
      inject: [FEATURE_RUNTIME_LIFECYCLE, SensorRegistryService],
    },
    ReloadSensorsUseCase,
    AddSensorUseCase,
    ModifySensorUseCase,
    RemoveSensorUseCase,
    ImportSensorsUseCase,
    ListSensorHistoryTargetsUseCase,
    SimulateSensorUseCase,
    ReadSensorLogHistoryUseCase,
    LibgpiodCliBackend,
    { provide: GPIO_BACKEND, useExisting: LibgpiodCliBackend },
    MqttConnectionPool,
    SensorResourcesLifecycleAdapter,
    { provide: CLOCK, useClass: SystemClockAdapter },
    { provide: SENSOR_REPOSITORY, useClass: DrizzleSensorRepository },
    { provide: SENSOR_LOG_REPOSITORY, useClass: DrizzleSensorLogRepository },
    { provide: SENSOR_LOG_EXPORT_READER, useClass: DrizzleSensorLogExportReader },
    { provide: SENSOR_QUERY, useClass: DrizzleSensorQuery },
    { provide: SENSOR_HEALTH, useExisting: SensorRegistryService },
    {
      provide: SENSOR_DRIVER_FACTORY,
      useFactory: (
        gpioBackend: GpioBackendPort,
        sensorLogs: SensorLogRepositoryPort,
        mqttPool: MqttConnectionPool,
      ): SensorDriverFactory =>
        SensorDriverFactoryProvider.build({ gpioBackend, sensorLogs, mqttPool }),
      inject: [GPIO_BACKEND, SENSOR_LOG_REPOSITORY, MqttConnectionPool],
    },
  ],
  exports: [
    DevSeederService,
    SensorRegistryService,
    ReloadSensorsUseCase,
    AddSensorUseCase,
    ModifySensorUseCase,
    RemoveSensorUseCase,
    ImportSensorsUseCase,
    ListSensorHistoryTargetsUseCase,
    SimulateSensorUseCase,
    ReadSensorLogHistoryUseCase,
    GPIO_BACKEND,
    MqttConnectionPool,
    SENSOR_REPOSITORY,
    SENSOR_LOG_REPOSITORY,
    SENSOR_LOG_EXPORT_READER,
    SENSOR_QUERY,
    SENSOR_HEALTH,
    SENSOR_DRIVER_FACTORY,
  ],
})
export class SensorModule {}

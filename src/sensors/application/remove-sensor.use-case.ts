import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, ClockPort } from '../../events/domain/ports/clock.port';
import { SensorNotFoundError } from '../domain/errors/sensor-not-found.error';
import {
  SENSOR_REPOSITORY,
  SensorRepositoryPort,
} from '../domain/ports/sensor-repository.port';
import { ReloadSensorsUseCase } from './reload-sensors.use-case';

/**
 * Spec 10 § /config remove + spec 01 § Sensor Deletion Flow.
 * Looks up by name, moves the row from `sensors` to `sensors_archive`,
 * then hot-reloads to tear down the live driver (freeing the GPIO pin).
 */
@Injectable()
export class RemoveSensorUseCase {
  constructor(
    @Inject(SENSOR_REPOSITORY)
    private readonly repository: SensorRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly reload: ReloadSensorsUseCase,
  ) {}

  async execute(sensorName: string): Promise<void> {
    const sensor = await this.repository.findByName(sensorName);
    if (!sensor) throw new SensorNotFoundError(sensorName);
    await this.repository.archive(sensor.id, this.clock.now());
    await this.reload.execute();
  }
}

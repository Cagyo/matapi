import { Inject, Injectable } from '@nestjs/common';
import {
  SENSOR_QUERY,
  SensorQueryPort,
} from '../../sensors/domain/ports/sensor-query.port';
import { SensorAlreadyMutedError } from '../domain/errors/sensor-already-muted.error';
import { SensorNotFoundError } from '../domain/errors/sensor-not-found.error';
import {
  USER_SENSOR_MUTE_REPOSITORY,
  UserSensorMuteRepositoryPort,
} from '../domain/ports/user-sensor-mute-repository.port';

/** Spec 12 — `/mute <sensor>`. Per-user, per-sensor notification mute. */
@Injectable()
export class MuteSensorUseCase {
  constructor(
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    @Inject(USER_SENSOR_MUTE_REPOSITORY)
    private readonly mutes: UserSensorMuteRepositoryPort,
  ) {}

  async execute(userId: number, sensorName: string): Promise<void> {
    const lookup = await this.sensors.findByName(sensorName);
    if (lookup?.kind !== 'active') {
      throw new SensorNotFoundError(sensorName);
    }
    if (await this.mutes.isMuted(userId, lookup.sensor.id)) {
      throw new SensorAlreadyMutedError(lookup.sensor.name);
    }
    await this.mutes.mute(userId, lookup.sensor.id);
  }
}

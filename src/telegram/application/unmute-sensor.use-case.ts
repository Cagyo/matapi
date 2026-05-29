import { Inject, Injectable } from '@nestjs/common';
import {
  SENSOR_QUERY,
  SensorQueryPort,
} from '../../sensors/domain/ports/sensor-query.port';
import { SensorNotFoundError } from '../domain/errors/sensor-not-found.error';
import { SensorNotMutedError } from '../domain/errors/sensor-not-muted.error';
import {
  USER_SENSOR_MUTE_REPOSITORY,
  UserSensorMuteRepositoryPort,
} from '../domain/ports/user-sensor-mute-repository.port';

/** Spec 12 — `/unmute <sensor>`. */
@Injectable()
export class UnmuteSensorUseCase {
  constructor(
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    @Inject(USER_SENSOR_MUTE_REPOSITORY)
    private readonly mutes: UserSensorMuteRepositoryPort,
  ) {}

  async execute(userId: number, sensorName: string): Promise<void> {
    const lookup = await this.sensors.findByName(sensorName);
    if (!lookup || lookup.kind !== 'active') {
      throw new SensorNotFoundError(sensorName);
    }
    if (!(await this.mutes.isMuted(userId, lookup.sensor.id))) {
      throw new SensorNotMutedError(lookup.sensor.name);
    }
    await this.mutes.unmute(userId, lookup.sensor.id);
  }
}

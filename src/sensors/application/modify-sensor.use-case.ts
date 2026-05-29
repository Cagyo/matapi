import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, ClockPort } from '../../events/domain/ports/clock.port';
import { DigitalConfigInvalidError } from '../domain/errors/digital-config-invalid.error';
import {
  isValidSensorName,
  InvalidSensorNameError,
} from '../domain/errors/invalid-sensor-name.error';
import { PinAlreadyInUseError } from '../domain/errors/pin-already-in-use.error';
import { SensorNameExistsError } from '../domain/errors/sensor-name-exists.error';
import { SensorNotFoundError } from '../domain/errors/sensor-not-found.error';
import { GpioPin } from '../domain/gpio-pin.value-object';
import {
  SENSOR_REPOSITORY,
  SensorRepositoryPort,
} from '../domain/ports/sensor-repository.port';
import { Sensor, SensorSeverity } from '../domain/sensor';
import { ReloadSensorsUseCase } from './reload-sensors.use-case';

export interface ModifySensorInput {
  /** Current sensor name (used to locate the row). */
  currentName: string;
  /** Optional patch fields. Absent fields keep their existing value. */
  patch: {
    name?: string;
    config?: Record<string, unknown>;
    debounceMs?: number;
    severity?: SensorSeverity;
  };
}

/**
 * Spec 10 § /config modify. Locates the sensor by name, applies a partial
 * patch with the same cross-row invariants as `AddSensorUseCase`
 * (name uniqueness, digital pin uniqueness), and triggers reload.
 */
@Injectable()
export class ModifySensorUseCase {
  constructor(
    @Inject(SENSOR_REPOSITORY)
    private readonly repository: SensorRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly reload: ReloadSensorsUseCase,
  ) {}

  async execute(input: ModifySensorInput): Promise<Sensor> {
    const current = await this.repository.findByName(input.currentName);
    if (!current) throw new SensorNotFoundError(input.currentName);

    if (input.patch.name !== undefined && input.patch.name !== current.name) {
      if (!isValidSensorName(input.patch.name)) {
        throw new InvalidSensorNameError(input.patch.name);
      }
      const collision = await this.repository.findByName(input.patch.name);
      if (collision && collision.id !== current.id) {
        throw new SensorNameExistsError(input.patch.name);
      }
    }

    if (input.patch.config !== undefined && current.type === 'digital') {
      const pin = input.patch.config?.pin;
      if (typeof pin !== 'number') {
        throw new DigitalConfigInvalidError('missing required numeric "pin"');
      }
      new GpioPin(pin);
      const owner = await this.repository.findActivePinOwner(pin);
      if (owner && owner.id !== current.id) {
        throw new PinAlreadyInUseError(pin, owner.name);
      }
    }

    const updated = await this.repository.update(current.id, {
      ...input.patch,
      updatedAt: this.clock.now(),
    });
    await this.reload.execute();
    return updated;
  }
}

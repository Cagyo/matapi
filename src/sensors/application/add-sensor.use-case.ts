import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CLOCK, ClockPort } from '../../events/domain/ports/clock.port';
import { DigitalConfigInvalidError } from '../domain/errors/digital-config-invalid.error';
import {
  isValidSensorName,
  InvalidSensorNameError,
} from '../domain/errors/invalid-sensor-name.error';
import { PinAlreadyInUseError } from '../domain/errors/pin-already-in-use.error';
import { SensorNameExistsError } from '../domain/errors/sensor-name-exists.error';
import { GpioPin } from '../domain/gpio-pin.value-object';
import {
  SENSOR_REPOSITORY,
  SensorRepositoryPort,
} from '../domain/ports/sensor-repository.port';
import { Sensor, SensorSeverity, SensorType } from '../domain/sensor';
import { ReloadSensorsUseCase } from './reload-sensors.use-case';

export interface AddSensorInput {
  name: string;
  type: SensorType;
  config: Record<string, unknown>;
  debounceMs: number;
  severity: SensorSeverity;
}

/**
 * Spec 10 § /config add. Validates name + config, enforces pin uniqueness
 * for digital sensors, persists the new row, then hot-reloads the live
 * sensor pipeline.
 *
 * Type-specific config validation (pin range, threshold ordering) lives in
 * the driver adapters (`DigitalGpioAdapter.parseConfig`, `parseUartCo2Config`)
 * and is exercised at registry reload time. The use case enforces only the
 * cross-row invariants: name uniqueness and pin uniqueness.
 */
@Injectable()
export class AddSensorUseCase {
  constructor(
    @Inject(SENSOR_REPOSITORY)
    private readonly repository: SensorRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(forwardRef(() => ReloadSensorsUseCase))
    private readonly reload: ReloadSensorsUseCase,
  ) {}

  async execute(input: AddSensorInput): Promise<Sensor> {
    if (!isValidSensorName(input.name)) {
      throw new InvalidSensorNameError(input.name);
    }
    if (await this.repository.findByName(input.name)) {
      throw new SensorNameExistsError(input.name);
    }
    if (input.type === 'digital') {
      const pin = readPin(input.config);
      // Construct value object → throws InvalidGpioPinError on bad range.
      new GpioPin(pin);
      const owner = await this.repository.findActivePinOwner(pin);
      if (owner) throw new PinAlreadyInUseError(pin, owner.name);
    }

    const now = this.clock.now();
    const created = await this.repository.create({
      id: randomUUID(),
      name: input.name,
      type: input.type,
      config: input.config,
      debounceMs: input.debounceMs,
      severity: input.severity,
      createdAt: now,
    });

    await this.reload.execute();
    return created;
  }
}

function readPin(raw: Record<string, unknown>): number {
  const pin = raw?.pin;
  if (typeof pin !== 'number') {
    throw new DigitalConfigInvalidError('missing required numeric "pin"');
  }
  return pin;
}

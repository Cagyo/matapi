import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { SensorNotSimulatableError } from '../domain/errors/sensor-not-simulatable.error';
import { isSimulatable } from '../domain/ports/simulatable-sensor.port';
import { SensorRegistryService } from './sensor-registry.service';

/**
 * Dev-only use case: push a simulated reading into a live driver so the full
 * pipeline (driver → event queue → notification → Telegram) fires exactly as
 * it would for real hardware (spec 26 § Mock GPIO Simulator).
 *
 * Throws `SensorNotSimulatableError` when the sensor isn't active or its
 * driver isn't a mock adapter.
 */
@Injectable()
export class SimulateSensorUseCase {
  constructor(
    @Inject(forwardRef(() => SensorRegistryService))
    private readonly registry: SensorRegistryService,
  ) {}

  execute(sensorId: string, value: number): void {
    const driver = this.registry.getDriver(sensorId);
    if (!driver || !isSimulatable(driver)) {
      throw new SensorNotSimulatableError(sensorId);
    }
    driver.simulate(value);
  }
}

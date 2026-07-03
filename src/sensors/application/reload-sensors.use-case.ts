import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { SensorRegistryService } from './sensor-registry.service';

/**
 * Thin application use case for hot-reloading the live sensor pipeline.
 * Bot commands (`/config add|modify|remove`, `/import_config`) invoke this
 * after persisting changes — see spec 02 § Hot-Reload Flow.
 */
@Injectable()
export class ReloadSensorsUseCase {
  constructor(
    @Inject(forwardRef(() => SensorRegistryService))
    private readonly registry: SensorRegistryService,
  ) {}

  execute(): Promise<void> {
    return this.registry.reload();
  }
}

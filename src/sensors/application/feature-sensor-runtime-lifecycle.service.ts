import { Injectable } from '@nestjs/common';
import type { ManageableFeatureName } from '../../features/domain/manageable-feature';
import type { FeatureRuntimeLifecyclePort } from '../../features/domain/ports/feature-runtime-lifecycle.port';
import { SensorRegistryService } from './sensor-registry.service';

/** Bridges feature enable/disable transitions to the live sensor registry. */
@Injectable()
export class FeatureSensorRuntimeLifecycleService {
  constructor(private readonly registry: SensorRegistryService) {}

  forFeature(name: ManageableFeatureName): FeatureRuntimeLifecyclePort {
    return {
      beforeDisable: () => this.registry.stopFeature(name),
      afterEnable: () => this.registry.resumeFeature(name),
    };
  }
}

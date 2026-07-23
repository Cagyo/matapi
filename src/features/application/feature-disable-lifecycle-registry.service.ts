import { Injectable } from '@nestjs/common';
import type {
  FeatureRuntimeLifecyclePort,
  FeatureRuntimeLifecycleRegistryPort,
} from '../domain/ports/feature-runtime-lifecycle.port';
import type { ManageableFeatureName } from '../domain/manageable-feature';

/** Composition seam for feature-specific runtime cleanup and reload. */
@Injectable()
export class FeatureDisableLifecycleRegistry
  implements FeatureRuntimeLifecycleRegistryPort
{
  private readonly lifecycles = new Map<ManageableFeatureName, FeatureRuntimeLifecyclePort>();

  register(name: ManageableFeatureName, lifecycle: FeatureRuntimeLifecyclePort): void {
    if (this.lifecycles.has(name)) {
      throw new RangeError(`Feature runtime lifecycle already registered: ${name}`);
    }
    this.lifecycles.set(name, lifecycle);
  }

  async beforeDisable(name: ManageableFeatureName): Promise<void> {
    await this.lifecycles.get(name)?.beforeDisable();
  }

  async afterEnable(name: ManageableFeatureName): Promise<void> {
    await this.lifecycles.get(name)?.afterEnable();
  }
}

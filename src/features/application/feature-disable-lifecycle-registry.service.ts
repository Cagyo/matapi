import { Injectable } from '@nestjs/common';
import type {
  FeatureDisableLifecyclePort,
  FeatureDisableLifecycleRegistryPort,
} from '../domain/ports/feature-disable-lifecycle.port';

/** Composition seam for feature-specific pre-disable cleanup. */
@Injectable()
export class FeatureDisableLifecycleRegistry
  implements FeatureDisableLifecycleRegistryPort
{
  private readonly lifecycles = new Set<FeatureDisableLifecyclePort>();

  register(lifecycle: FeatureDisableLifecyclePort): void {
    this.lifecycles.add(lifecycle);
  }

  async beforeDisable(name: string): Promise<void> {
    for (const lifecycle of this.lifecycles) {
      await lifecycle.beforeDisable(name);
    }
  }
}

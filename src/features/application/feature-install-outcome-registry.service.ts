import { Injectable } from '@nestjs/common';
import type { FeatureInstallJob } from '../domain/manageable-feature';
import type {
  FeatureInstallOutcomePort,
  FeatureInstallOutcomeRegistryPort,
} from '../domain/ports/feature-install-outcome.port';

/**
 * Delivery is deliberately late-bound: a Telegram listener may be registered
 * by its own module, while terminal persistence remains independent of it.
 */
@Injectable()
export class FeatureInstallOutcomeRegistryService
  implements FeatureInstallOutcomeRegistryPort
{
  private readonly listeners = new Set<FeatureInstallOutcomePort>();

  register(listener: FeatureInstallOutcomePort): void {
    this.listeners.add(listener);
  }

  async notify(job: FeatureInstallJob): Promise<void> {
    await Promise.all([...this.listeners].map(async (listener) => {
      try {
        await listener.notify(job);
      } catch {
        // Receipt delivery is retried by recovery; it must never alter state.
      }
    }));
  }
}

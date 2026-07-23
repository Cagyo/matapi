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
  private readonly terminalJobs = new Map<string, FeatureInstallJob>();
  private deliveryTail: Promise<void> = Promise.resolve();

  register(listener: FeatureInstallOutcomePort): void {
    this.listeners.add(listener);
    // Feature recovery can run before Telegram finishes booting. Preserve the
    // exact persisted job identity and replay it to a late listener in order.
    void this.enqueue([listener], [...this.terminalJobs.values()]);
  }

  async notify(job: FeatureInstallJob): Promise<void> {
    this.terminalJobs.set(job.id, job);
    await this.enqueue([...this.listeners], [job]);
  }

  private enqueue(
    listeners: readonly FeatureInstallOutcomePort[],
    jobs: readonly FeatureInstallJob[],
  ): Promise<void> {
    const delivery = this.deliveryTail.then(async () => {
      for (const job of jobs) {
        for (const listener of listeners) {
          try {
            await listener.notify(job);
          } catch {
            // Receipt delivery is retried by recovery; it must never alter state.
          }
        }
      }
    });
    this.deliveryTail = delivery.catch(() => undefined);
    return delivery;
  }
}

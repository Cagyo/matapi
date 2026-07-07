import { Injectable, Logger } from '@nestjs/common';
import { CleanupCoordinatorService, CleanupResult } from './cleanup-coordinator.service';

/**
 * Manually triggers storage cleanups across local disk and Google Drive (spec 21).
 *
 * Routes through `CleanupCoordinatorService` to guarantee concurrency safety
 * against background interval cleanups. Returns a structured result containing
 * whether the cleanup executed and the threshold percentage used.
 */
@Injectable()
export class TriggerCleanUseCase {
  private readonly logger = new Logger(TriggerCleanUseCase.name);

  constructor(private readonly coordinator: CleanupCoordinatorService) {}

  async execute(customThreshold?: number): Promise<CleanupResult> {
    this.logger.log(
      `Triggering manual storage cleanup${customThreshold ? ` (threshold: ${customThreshold}%)` : ''}`,
    );
    return this.coordinator.runCleanup('both', customThreshold);
  }
}

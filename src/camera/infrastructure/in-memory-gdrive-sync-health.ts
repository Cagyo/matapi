import { Injectable } from '@nestjs/common';
import {
  GdriveSyncHealthPort,
  GdriveSyncHealthSnapshot,
} from '../domain/ports/gdrive-sync-health.port';

/**
 * In-process `GdriveSyncHealthPort`. The Drive upload loop runs inside this
 * worker, so a single shared instance is the source of truth for both
 * dev and production. Starts healthy.
 */
@Injectable()
export class InMemoryGdriveSyncHealth implements GdriveSyncHealthPort {
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private lastSuccessAt: Date | null = null;

  snapshot(): GdriveSyncHealthSnapshot {
    return {
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
    };
  }

  recordSuccess(at: Date): void {
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.lastSuccessAt = at;
  }

  recordFailure(error: string): void {
    this.consecutiveFailures += 1;
    this.lastError = error;
  }
}

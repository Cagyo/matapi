import { Injectable } from '@nestjs/common';
import type { ArchiveArtifactKind } from '../domain/archive-artifact.entity';

export type ArchiveTransferRelease = () => void;

interface Waiter {
  readonly priority: ArchiveArtifactKind;
  readonly resolve: (release: ArchiveTransferRelease) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

/** One fair, priority-aware transfer slot shared by every archive upload. */
@Injectable()
export class ArchiveTransferSemaphoreService {
  private readonly waiters: Waiter[] = [];
  private readonly maxConsecutiveBackups: number;
  private held = false;
  private consecutiveBackups = 0;

  constructor(options: { maxConsecutiveBackups?: number } = {}) {
    this.maxConsecutiveBackups = options.maxConsecutiveBackups ?? 3;
    if (!Number.isSafeInteger(this.maxConsecutiveBackups) || this.maxConsecutiveBackups < 1) {
      throw new Error('Archive transfer fairness bound is invalid');
    }
  }

  acquire(priority: ArchiveArtifactKind, signal: AbortSignal): Promise<ArchiveTransferRelease> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        priority,
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortReason(signal));
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
      this.dispatch();
    });
  }

  private dispatch(): void {
    if (this.held || this.waiters.length === 0) return;
    const index = this.nextWaiterIndex();
    const [waiter] = this.waiters.splice(index, 1);
    waiter.signal.removeEventListener('abort', waiter.onAbort);
    if (waiter.signal.aborted) {
      waiter.reject(abortReason(waiter.signal));
      this.dispatch();
      return;
    }
    this.held = true;
    this.consecutiveBackups = waiter.priority === 'database_backup' ? this.consecutiveBackups + 1 : 0;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      this.held = false;
      this.dispatch();
    });
  }

  private nextWaiterIndex(): number {
    const firstBackup = this.waiters.findIndex((waiter) => waiter.priority === 'database_backup');
    const firstVideo = this.waiters.findIndex((waiter) => waiter.priority === 'motion_video');
    if (firstBackup < 0) return firstVideo;
    if (firstVideo < 0) return firstBackup;
    return this.consecutiveBackups >= this.maxConsecutiveBackups ? firstVideo : firstBackup;
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

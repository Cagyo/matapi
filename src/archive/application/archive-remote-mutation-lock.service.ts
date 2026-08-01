import { Injectable } from '@nestjs/common';

/**
 * Serializes only the exact provider mutation selected by reconciliation or
 * retention. Callers must do discovery and every long transfer outside this
 * lock, then pass only the short fenced mutation closure here.
 */
@Injectable()
export class ArchiveRemoteMutationLockService {
  private tail: Promise<void> = Promise.resolve();
  private activeActivities = 0;
  private cleanupActive = false;
  private readonly cleanupWaiters: (() => void)[] = [];

  async runExclusive<T>(mutation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const predecessor = this.tail;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      return await mutation();
    } finally {
      release();
    }
  }

  /** Marks a transfer/reconciliation active so local deletion cannot overlap it. */
  async runActivity<T>(operation: () => Promise<T>): Promise<T> {
    while (this.cleanupActive) {
      await new Promise<void>((resolve) => { this.cleanupWaiters.push(resolve); });
    }
    this.activeActivities += 1;
    try {
      return await operation();
    } finally {
      this.activeActivities -= 1;
    }
  }

  /** Admits cleanup only when no upload/reconciliation is active. */
  async tryRunCleanup<T>(operation: () => Promise<T>): Promise<T | null> {
    if (this.cleanupActive || this.activeActivities > 0) return null;
    this.cleanupActive = true;
    try {
      return await operation();
    } finally {
      this.cleanupActive = false;
      for (const release of this.cleanupWaiters.splice(0)) release();
    }
  }
}

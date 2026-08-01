import { Injectable } from '@nestjs/common';

/**
 * Serializes only the exact provider mutation selected by reconciliation or
 * retention. Callers must do discovery and every long transfer outside this
 * lock, then pass only the short fenced mutation closure here.
 */
@Injectable()
export class ArchiveRemoteMutationLockService {
  private tail: Promise<void> = Promise.resolve();

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
}

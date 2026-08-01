import { describe, expect, it } from 'vitest';
import { ArchiveRemoteMutationLockService } from '../../../src/archive/application/archive-remote-mutation-lock.service';

describe('ArchiveRemoteMutationLockService activity gate', () => {
  it('refuses cleanup while an upload/reconciliation activity is still running', async () => {
    const gate = new ArchiveRemoteMutationLockService() as ArchiveRemoteMutationLockService & {
      runActivity<T>(operation: () => Promise<T>): Promise<T>;
      tryRunCleanup<T>(operation: () => Promise<T>): Promise<T | null>;
    };
    expect(typeof gate.runActivity).toBe('function');
    expect(typeof gate.tryRunCleanup).toBe('function');
    let release!: () => void;
    const active = gate.runActivity(() => new Promise<void>((resolve) => { release = resolve; }));

    const cleanup = await gate.tryRunCleanup(async () => 'deleted');

    expect(cleanup).toBeNull();
    release();
    await active;
    await expect(gate.tryRunCleanup(async () => 'deleted')).resolves.toBe('deleted');
  });

  it('delays a newly-starting upload until an admitted cleanup has finished', async () => {
    const gate = new ArchiveRemoteMutationLockService() as ArchiveRemoteMutationLockService & {
      runActivity<T>(operation: () => Promise<T>): Promise<T>;
      tryRunCleanup<T>(operation: () => Promise<T>): Promise<T | null>;
    };
    expect(typeof gate.runActivity).toBe('function');
    expect(typeof gate.tryRunCleanup).toBe('function');
    let releaseCleanup!: () => void;
    const order: string[] = [];
    const cleanup = gate.tryRunCleanup(() => new Promise<string>((resolve) => {
      order.push('cleanup-start');
      releaseCleanup = () => {
        order.push('cleanup-end');
        resolve('cleaned');
      };
    }));
    const upload = gate.runActivity(async () => { order.push('upload-start'); });
    await Promise.resolve();

    expect(order).toEqual(['cleanup-start']);
    releaseCleanup();
    await Promise.all([cleanup, upload]);
    expect(order).toEqual(['cleanup-start', 'cleanup-end', 'upload-start']);
  });

  it('serializes admitted cleanup behind an existing exact remote mutation', async () => {
    const gate = new ArchiveRemoteMutationLockService();
    let releaseMutation!: () => void;
    const order: string[] = [];
    const mutation = gate.runExclusive(() => new Promise<void>((resolve) => {
      order.push('mutation-start');
      releaseMutation = () => {
        order.push('mutation-end');
        resolve();
      };
    }));
    const cleanup = gate.tryRunCleanup(() => gate.runExclusive(async () => {
      order.push('cleanup');
      return 'cleaned';
    }));
    await Promise.resolve();

    expect(order).toEqual(['mutation-start']);
    releaseMutation();
    await mutation;
    await expect(cleanup).resolves.toBe('cleaned');
    expect(order).toEqual(['mutation-start', 'mutation-end', 'cleanup']);
  });
});

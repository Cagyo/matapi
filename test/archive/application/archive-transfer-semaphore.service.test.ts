import { describe, expect, it } from 'vitest';
import { ArchiveTransferSemaphoreService } from '../../../src/archive/application/archive-transfer-semaphore.service';

describe('ArchiveTransferSemaphoreService', () => {
  it('allows exactly one active transfer and preserves FIFO order within a priority', async () => {
    const semaphore = new ArchiveTransferSemaphoreService();
    const first = await semaphore.acquire('motion_video', new AbortController().signal);
    const order: string[] = [];
    const second = semaphore.acquire('motion_video', new AbortController().signal).then((release) => { order.push('second'); return release; });
    const third = semaphore.acquire('motion_video', new AbortController().signal).then((release) => { order.push('third'); return release; });

    first();
    const releaseSecond = await second;
    expect(order).toEqual(['second']);
    releaseSecond();
    (await third)();
    expect(order).toEqual(['second', 'third']);
  });

  it('prioritizes backups but admits a waiting video after the bounded backup burst', async () => {
    const semaphore = new ArchiveTransferSemaphoreService({ maxConsecutiveBackups: 2 });
    const active = await semaphore.acquire('motion_video', new AbortController().signal);
    const order: string[] = [];
    const video = semaphore.acquire('motion_video', new AbortController().signal).then((release) => { order.push('video'); return release; });
    const backup1 = semaphore.acquire('database_backup', new AbortController().signal).then((release) => { order.push('backup-1'); return release; });
    const backup2 = semaphore.acquire('database_backup', new AbortController().signal).then((release) => { order.push('backup-2'); return release; });
    const backup3 = semaphore.acquire('database_backup', new AbortController().signal).then((release) => { order.push('backup-3'); return release; });

    active();
    (await backup1)();
    (await backup2)();
    await Promise.resolve();
    expect(order).toEqual(['backup-1', 'backup-2', 'video']);
    (await video)();
    (await backup3)();
  });

  it('removes an aborted waiter without consuming the transfer slot', async () => {
    const semaphore = new ArchiveTransferSemaphoreService();
    const active = await semaphore.acquire('motion_video', new AbortController().signal);
    const cancelled = new AbortController();
    const waiting = semaphore.acquire('database_backup', cancelled.signal);
    cancelled.abort(new Error('cancelled'));

    await expect(waiting).rejects.toThrow('cancelled');
    active();
    const release = await semaphore.acquire('motion_video', new AbortController().signal);
    release();
  });
});

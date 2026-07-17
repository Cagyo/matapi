import { describe, expect, it } from 'vitest';
import { WorkflowOperationQueue } from '../../../src/telegram/interfaces/workflow-operation.queue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('WorkflowOperationQueue', () => {
  it('serializes the full operation for the same user and private chat', async () => {
    const queue = new WorkflowOperationQueue();
    const gate = deferred();
    const events: string[] = [];
    const first = queue.run(7, 70, async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
    });
    const second = queue.run(7, 70, async () => { events.push('second'); });
    await Promise.resolve();

    expect(events).toEqual(['first:start']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('does not let a rejected operation poison the next operation for the key', async () => {
    const queue = new WorkflowOperationQueue();
    const first = queue.run(7, 70, async () => { throw new Error('failed'); });
    const second = queue.run(7, 70, async () => 'recovered');

    await expect(first).rejects.toThrow('failed');
    await expect(second).resolves.toBe('recovered');
  });

  it('publishes the key before invoking an operation that synchronously enqueues more work', async () => {
    const queue = new WorkflowOperationQueue();
    const events: string[] = [];
    let nested!: Promise<void>;

    await queue.run(7, 70, async () => {
      events.push('outer:start');
      nested = queue.run(7, 70, async () => { events.push('nested'); });
      events.push('outer:end');
    });
    await nested;

    expect(events).toEqual(['outer:start', 'outer:end', 'nested']);
  });

  it('allows unrelated user/chat keys to progress independently', async () => {
    const queue = new WorkflowOperationQueue();
    const gate = deferred();
    const first = queue.run(7, 70, async () => gate.promise);

    await expect(queue.run(8, 80, async () => 'independent')).resolves.toBe('independent');
    gate.resolve();
    await first;
  });

  it('deletes idle keys after success and failure instead of retaining operation data', async () => {
    const queue = new WorkflowOperationQueue();
    await queue.run(7, 70, async () => undefined);
    await expect(queue.run(8, 80, async () => { throw new Error('failed'); })).rejects.toThrow('failed');

    expect((queue as unknown as { operations: Map<string, Promise<void>> }).operations.size).toBe(0);
  });
});

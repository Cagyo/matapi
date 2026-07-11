import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryEventRepository } from '../../../src/events/infrastructure/in-memory-event.repository';

async function enqueue(
  repository: InMemoryEventRepository,
  sensorId: string,
  timestamp: string,
) {
  return repository.enqueue({
    sensorId,
    type: 'state_change',
    payload: { newValue: true },
    createdAt: new Date(timestamp),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('InMemoryEventRepository', () => {
  it('assigns ids and returns pending events by creation time with null dates last', async () => {
    const repository = new InMemoryEventRepository();
    const latest = await repository.enqueue({
      sensorId: 'latest',
      type: 'state_change',
      payload: null,
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    const unknownTime = await repository.enqueue({
      sensorId: 'unknown',
      type: 'system',
      payload: null,
      createdAt: null as never,
    });
    const earliest = await repository.enqueue({
      sensorId: 'earliest',
      type: 'state_change',
      payload: null,
      createdAt: new Date('2029-12-31T23:59:00.000Z'),
    });

    expect([latest.id, unknownTime.id, earliest.id]).toEqual([1, 2, 3]);
    expect((await repository.pending()).map((event) => event.id)).toEqual([3, 1, 2]);
  });

  it('marks only requested events as sent', async () => {
    const repository = new InMemoryEventRepository();
    const first = await repository.enqueue({
      sensorId: 'first',
      type: 'state_change',
      payload: null,
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    const second = await repository.enqueue({
      sensorId: 'second',
      type: 'state_change',
      payload: null,
      createdAt: new Date('2030-01-01T00:00:01.000Z'),
    });
    const sentAt = new Date('2030-01-01T00:01:00.000Z');

    await repository.markSent([first.id], sentAt);

    expect((await repository.pending()).map((event) => event.id)).toEqual([second.id]);
    expect(repository.sentAtFor(first.id)).toBe(sentAt);
    expect(repository.sentAtFor(second.id)).toBeNull();
    expect(repository.sentAtFor(999)).toBeUndefined();
  });

  it('evicts the oldest unsent event before inserting at capacity', async () => {
    const repository = new InMemoryEventRepository({ maxUnsentEvents: 2 });
    const first = await enqueue(repository, 'first', '2030-01-01T00:00:00.000Z');
    const second = await enqueue(repository, 'second', '2030-01-01T00:01:00.000Z');
    const latest = await enqueue(repository, 'latest', '2030-01-01T00:02:00.000Z');

    expect((await repository.pending()).map((event) => event.id)).toEqual([second.id, latest.id]);
    expect((await repository.pending()).map((event) => event.id)).not.toContain(first.id);
  });

  it('breaks equal created-at eviction ties by ID', async () => {
    const repository = new InMemoryEventRepository({ maxUnsentEvents: 2 });
    const first = await enqueue(repository, 'first', '2030-01-01T00:00:00.000Z');
    const second = await enqueue(repository, 'second', '2030-01-01T00:00:00.000Z');
    const latest = await enqueue(repository, 'latest', '2030-01-01T00:00:00.000Z');

    expect((await repository.pending()).map((event) => event.id)).toEqual([second.id, latest.id]);
    expect((await repository.pending()).map((event) => event.id)).not.toContain(first.id);
  });

  it('warns only at power-of-two overflow counts', async () => {
    const warning = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const repository = new InMemoryEventRepository({ maxUnsentEvents: 1 });

    await enqueue(repository, 'first', '2030-01-01T00:00:00.000Z');
    await enqueue(repository, 'second', '2030-01-01T00:01:00.000Z');
    await enqueue(repository, 'third', '2030-01-01T00:02:00.000Z');
    await enqueue(repository, 'fourth', '2030-01-01T00:03:00.000Z');

    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenNthCalledWith(1, expect.stringContaining('1'));
    expect(warning).toHaveBeenNthCalledWith(2, expect.stringContaining('2'));
  });
});

import { describe, expect, it } from 'vitest';
import { InMemoryEventRepository } from '../../../src/events/infrastructure/in-memory-event.repository';

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
});
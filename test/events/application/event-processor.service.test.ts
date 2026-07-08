import { describe, expect, it, vi } from 'vitest';
import { EventProcessorService } from '../../../src/events/application/event-processor.service';
import { SensorEventSourcePort } from '../../../src/events/domain/ports/sensor-event-source.port';
import { SensorEvent } from '../../../src/events/domain/sensor-event';

class TestSensorEventSource implements SensorEventSourcePort {
  callback?: (event: SensorEvent) => void;

  onEvent(callback: (event: SensorEvent) => void): void {
    this.callback = callback;
  }

  emit(event: SensorEvent): void {
    this.callback?.(event);
  }
}

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

function makeEvent(): SensorEvent {
  return {
    sensorId: 'front_door',
    type: 'state_change',
    newValue: true,
    timestamp: new Date('2030-01-01T00:00:00.000Z'),
  };
}

describe('EventProcessorService', () => {
  it('subscribes to sensor events, enqueues them, and processes notifications', async () => {
    const source = new TestSensorEventSource();
    const queued = { id: 7 };
    const eventQueue = {
      enqueueSensorEvent: vi.fn().mockResolvedValue(queued),
    };
    const drainEventQueue = { execute: vi.fn().mockResolvedValue(undefined) };
    const notifications = { process: vi.fn().mockResolvedValue(undefined) };
    const service = new EventProcessorService(
      eventQueue as never,
      drainEventQueue as never,
      notifications as never,
      source,
    );

    service.onModuleInit();
    const event = makeEvent();
    source.emit(event);
    await flushAsync();

    expect(eventQueue.enqueueSensorEvent).toHaveBeenCalledWith(event);
    expect(notifications.process).toHaveBeenCalledWith(queued);
    expect(drainEventQueue.execute).not.toHaveBeenCalled();
  });

  it('exposes a direct drain method for startup and manual retries', async () => {
    const source = new TestSensorEventSource();
    const drainEventQueue = { execute: vi.fn().mockResolvedValue(undefined) };
    const service = new EventProcessorService(
      { enqueueSensorEvent: vi.fn() } as never,
      drainEventQueue as never,
      { process: vi.fn() } as never,
      source,
    );

    await service.drain();

    expect(drainEventQueue.execute).toHaveBeenCalledTimes(1);
  });

  it('does not process notifications when enqueueing the event fails', async () => {
    const source = new TestSensorEventSource();
    const eventQueue = {
      enqueueSensorEvent: vi.fn().mockRejectedValue(new Error('db offline')),
    };
    const drainEventQueue = { execute: vi.fn().mockResolvedValue(undefined) };
    const notifications = { process: vi.fn().mockResolvedValue(undefined) };
    const service = new EventProcessorService(
      eventQueue as never,
      drainEventQueue as never,
      notifications as never,
      source,
    );

    service.onModuleInit();
    source.emit(makeEvent());
    await flushAsync();

    expect(notifications.process).not.toHaveBeenCalled();
  });

  it('ignores new events once shutdown has begun', async () => {
    const source = new TestSensorEventSource();
    const eventQueue = { enqueueSensorEvent: vi.fn().mockResolvedValue({ id: 1 }) };
    const notifications = { process: vi.fn().mockResolvedValue(undefined) };
    const service = new EventProcessorService(
      eventQueue as never,
      { execute: vi.fn() } as never,
      notifications as never,
      source,
    );

    service.onModuleInit();
    service.beginShutdown();
    source.emit(makeEvent());
    await flushAsync();

    expect(eventQueue.enqueueSensorEvent).not.toHaveBeenCalled();
  });

  it('waitForIdle resolves only after in-flight events settle', async () => {
    const source = new TestSensorEventSource();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const eventQueue = {
      enqueueSensorEvent: vi.fn(async () => {
        await gate;
        return { id: 1 };
      }),
    };
    const notifications = { process: vi.fn().mockResolvedValue(undefined) };
    const service = new EventProcessorService(
      eventQueue as never,
      { execute: vi.fn() } as never,
      notifications as never,
      source,
    );

    service.onModuleInit();
    source.emit(makeEvent());
    await flushAsync();

    let idle = false;
    const wait = service.waitForIdle(1000).then(() => {
      idle = true;
    });
    await flushAsync();
    expect(idle).toBe(false);

    release();
    await wait;
    expect(idle).toBe(true);
  });

  it('waitForIdle gives up after the timeout when work never settles', async () => {
    const source = new TestSensorEventSource();
    const eventQueue = {
      enqueueSensorEvent: vi.fn(() => new Promise<{ id: number }>(() => {})),
    };
    const service = new EventProcessorService(
      eventQueue as never,
      { execute: vi.fn() } as never,
      { process: vi.fn() } as never,
      source,
    );

    service.onModuleInit();
    source.emit(makeEvent());
    await flushAsync();

    await expect(service.waitForIdle(60)).resolves.toBeUndefined();
  });

  it('caps the number of concurrently handled events', async () => {
    const source = new TestSensorEventSource();
    let active = 0;
    let maxActive = 0;
    const releases: (() => void)[] = [];
    const notifications = {
      process: vi.fn(() => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise<void>((resolve) => {
          releases.push(() => {
            active -= 1;
            resolve();
          });
        });
      }),
    };
    const eventQueue = {
      enqueueSensorEvent: vi.fn(async (e: SensorEvent) => ({
        id: Math.random(),
        sensorId: e.sensorId,
        type: e.type,
        payload: {},
        createdAt: e.timestamp,
      })),
    };

    const prev = process.env.EVENT_MAX_CONCURRENCY;
    process.env.EVENT_MAX_CONCURRENCY = '2';
    try {
      const service = new EventProcessorService(
        eventQueue as never,
        { execute: vi.fn() } as never,
        notifications as never,
        source,
      );
      service.onModuleInit();
      for (let i = 0; i < 5; i += 1) source.emit(makeEvent());
      await flushAsync();

      expect(maxActive).toBeLessThanOrEqual(2);
      expect(active).toBe(2); // exactly the cap is busy; 3 wait in the queue

      while (releases.length > 0) {
        releases.shift()!();
        await flushAsync();
      }
      expect(active).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.EVENT_MAX_CONCURRENCY;
      else process.env.EVENT_MAX_CONCURRENCY = prev;
    }
  });
});
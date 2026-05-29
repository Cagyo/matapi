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
});
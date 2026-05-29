import { describe, expect, it, vi } from 'vitest';
import { GracefulShutdownService } from '../../../src/system/application/graceful-shutdown.service';
import { EventProcessorService } from '../../../src/events/application/event-processor.service';
import { EventNotifierService } from '../../../src/events/application/event-notifier.service';
import { en } from '../../../src/locales/en';

describe('GracefulShutdownService', () => {
  it('stops events, drains, then broadcasts the offline notice in order', async () => {
    const order: string[] = [];
    const eventProcessor = {
      beginShutdown: vi.fn(() => order.push('begin')),
      waitForIdle: vi.fn(async () => {
        order.push('drain');
      }),
    } as unknown as EventProcessorService;
    const notifier = {
      isReady: () => true,
      notify: vi.fn(async () => {
        order.push('notify');
      }),
    } as unknown as EventNotifierService;

    const service = new GracefulShutdownService(eventProcessor, notifier);
    await service.run('SIGTERM');

    expect(order).toEqual(['begin', 'drain', 'notify']);
    expect(notifier.notify).toHaveBeenCalledWith({
      text: en.system.goingOffline,
      asFile: false,
    });
  });

  it('skips the offline notice when the notifier is not ready', async () => {
    const eventProcessor = {
      beginShutdown: vi.fn(),
      waitForIdle: vi.fn(async () => undefined),
    } as unknown as EventProcessorService;
    const notify = vi.fn();
    const notifier = {
      isReady: () => false,
      notify,
    } as unknown as EventNotifierService;

    const service = new GracefulShutdownService(eventProcessor, notifier);
    await service.run('SIGINT');

    expect(notify).not.toHaveBeenCalled();
  });
});

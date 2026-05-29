import { describe, expect, it, vi } from 'vitest';
import { EventNotifierService } from '../../../src/events/application/event-notifier.service';
import { NotifierPort } from '../../../src/events/domain/ports/notifier.port';

function makeNotifier(ready = true): NotifierPort & {
  notify: ReturnType<typeof vi.fn>;
  notifyUser: ReturnType<typeof vi.fn>;
  isReady: ReturnType<typeof vi.fn>;
} {
  return {
    isReady: vi.fn(() => ready),
    notify: vi.fn().mockResolvedValue(undefined),
    notifyUser: vi.fn().mockResolvedValue(undefined),
  };
}

describe('EventNotifierService', () => {
  it('reports not ready and rejects notifications before an adapter is registered', async () => {
    const service = new EventNotifierService();

    expect(service.isReady()).toBe(false);
    await expect(
      service.notify({ text: 'hello', asFile: false }),
    ).rejects.toThrow('Notifier is not ready');
  });

  it('delegates readiness and delivery to the registered adapter', async () => {
    const service = new EventNotifierService();
    const notifier = makeNotifier(true);

    service.register(notifier);
    await service.notify({ text: 'hello', asFile: false });

    expect(service.isReady()).toBe(true);
    expect(notifier.notify).toHaveBeenCalledWith({ text: 'hello', asFile: false });
  });

  it('clears the registered adapter', async () => {
    const service = new EventNotifierService();
    service.register(makeNotifier(true));

    service.clear();

    expect(service.isReady()).toBe(false);
    await expect(
      service.notify({ text: 'hello', asFile: false }),
    ).rejects.toThrow('Notifier is not ready');
  });

  it('rejects when the registered adapter is not ready', async () => {
    const service = new EventNotifierService();
    const notifier = makeNotifier(false);

    service.register(notifier);

    await expect(
      service.notify({ text: 'hello', asFile: false }),
    ).rejects.toThrow('Notifier is not ready');
    expect(notifier.notify).not.toHaveBeenCalled();
  });
});
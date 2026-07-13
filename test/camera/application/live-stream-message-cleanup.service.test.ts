import { describe, expect, it, vi } from 'vitest';
import { LiveStreamMessageCleanupService } from '../../../src/camera/application/live-stream-message-cleanup.service';
import type { LiveStreamMessageCleanupPort } from '../../../src/camera/domain/ports/live-stream-message-cleanup.port';

describe('LiveStreamMessageCleanupService', () => {
  it('is a safe no-op until Telegram registers a delegate', async () => {
    const service = new LiveStreamMessageCleanupService();

    await expect(service.delete({ chatId: 42, messageId: 9 })).resolves.toBeUndefined();
  });

  it('delegates after registration and stops after shutdown clear', async () => {
    const delegate: LiveStreamMessageCleanupPort = { delete: vi.fn() };
    const service = new LiveStreamMessageCleanupService();
    service.register(delegate);

    await service.delete({ chatId: 42, messageId: 9 });
    expect(delegate.delete).toHaveBeenCalledWith({ chatId: 42, messageId: 9 });

    service.clear();
    await service.delete({ chatId: 42, messageId: 10 });
    expect(delegate.delete).toHaveBeenCalledTimes(1);
  });
});

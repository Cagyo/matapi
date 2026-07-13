import { describe, expect, it, vi } from 'vitest';
import { TelegramLiveStreamMessageCleanupAdapter } from '../../../src/telegram/infrastructure/telegram-live-stream-message-cleanup.adapter';

describe('TelegramLiveStreamMessageCleanupAdapter', () => {
  it('deletes a registered watch message through the active bot', async () => {
    const deleteMessage = vi.fn().mockResolvedValue(true);
    const adapter = new TelegramLiveStreamMessageCleanupAdapter();
    adapter.setBot({ api: { deleteMessage } } as never);

    await adapter.delete({ chatId: 42, messageId: 9 });

    expect(deleteMessage).toHaveBeenCalledWith(42, 9);
  });

  it('treats missing or inaccessible Telegram messages as best effort', async () => {
    const deleteMessage = vi.fn().mockRejectedValue(new Error('message not found'));
    const adapter = new TelegramLiveStreamMessageCleanupAdapter();
    adapter.setBot({ api: { deleteMessage } } as never);

    await expect(adapter.delete({ chatId: 42, messageId: 9 })).resolves.toBeUndefined();
    adapter.clearBot();
    await expect(adapter.delete({ chatId: 42, messageId: 10 })).resolves.toBeUndefined();
  });
});

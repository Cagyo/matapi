import { Logger } from '@nestjs/common';
import type { Bot } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraSourceMessageDeletionError } from '../../../src/telegram/application/ports/camera-source-message.port';
import { TelegramCameraSourceMessageAdapter } from '../../../src/telegram/infrastructure/telegram-camera-source-message.adapter';
import type { TelegramContext } from '../../../src/telegram/interfaces/telegram-context';

const CHAT = 907_001;
const MESSAGE = 550_123;
/** Telegram's own wording quotes both identifiers it refused. */
const TELEGRAM_TEXT = 'Bad Request: message to delete not found (chat 907001, message 550123)';

function fakeBot(deleteMessage: ReturnType<typeof vi.fn>): Bot<TelegramContext> {
  return { api: { deleteMessage } } as unknown as Bot<TelegramContext>;
}

describe('TelegramCameraSourceMessageAdapter', () => {
  let adapter: TelegramCameraSourceMessageAdapter;
  let deleteMessage: ReturnType<typeof vi.fn>;
  let logged: unknown[];

  beforeEach(() => {
    adapter = new TelegramCameraSourceMessageAdapter();
    deleteMessage = vi.fn().mockResolvedValue(true);
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delegates the exact chat and message integers to grammY', async () => {
    adapter.setBot(fakeBot(deleteMessage));

    await expect(adapter.delete(CHAT, MESSAGE)).resolves.toBeUndefined();

    expect(deleteMessage.mock.calls).toEqual([[CHAT, MESSAGE]]);
    expect(logged).toEqual([]);
  });

  it('fails closed before a bot is set', async () => {
    await expect(adapter.delete(CHAT, MESSAGE)).rejects.toBeInstanceOf(
      CameraSourceMessageDeletionError,
    );
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('fails closed again once the bot is cleared', async () => {
    adapter.setBot(fakeBot(deleteMessage));
    adapter.clearBot();

    await expect(adapter.delete(CHAT, MESSAGE)).rejects.toBeInstanceOf(
      CameraSourceMessageDeletionError,
    );
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('rejects when Telegram refuses, carrying none of its text', async () => {
    deleteMessage.mockRejectedValue(new Error(TELEGRAM_TEXT));
    adapter.setBot(fakeBot(deleteMessage));

    const rejection = await adapter.delete(CHAT, MESSAGE).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(CameraSourceMessageDeletionError);
    const error = rejection as CameraSourceMessageDeletionError & { cause?: unknown };
    expect(error.cause).toBeUndefined();
    const carried = [
      error.message,
      error.stack ?? '',
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
      ...logged.map((entry) => String(entry)),
    ].join('\n');
    for (const secret of [
      TELEGRAM_TEXT,
      'message to delete not found',
      String(CHAT),
      String(MESSAGE),
    ]) {
      expect(carried).not.toContain(secret);
    }
  });
});

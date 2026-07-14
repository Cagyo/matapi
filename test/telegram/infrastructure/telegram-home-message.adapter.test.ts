import { describe, expect, it, vi } from 'vitest';
import type { Bot } from 'grammy';
import { catalogs } from '../../../src/locales/catalog';
import type { HomeScreen } from '../../../src/telegram/application/home-screen';
import type { HomeSummary } from '../../../src/telegram/application/get-home-summary.use-case';
import type { HomeIdentity } from '../../../src/telegram/domain/home-session';
import { TelegramHomeMessageAdapter } from '../../../src/telegram/infrastructure/telegram-home-message.adapter';

const identity: HomeIdentity = {
  userId: 7,
  chatId: 9,
  messageId: 11,
  token: 'AbCdEfGhIjKlMnO_',
  revision: 2,
};

const summary: HomeSummary = {
  verdict: 'normal',
  sensors: [],
  attention: [],
  attentionTotal: 0,
  knownCount: 0,
  unknownCount: 0,
  health: null,
  healthFresh: false,
  notificationState: { kind: 'normal' },
};

const screen: HomeScreen = { kind: 'home', summary, checking: false };

function fakeBot() {
  const api = {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
  };
  return { api, bot: { api } as unknown as Bot };
}

describe('TelegramHomeMessageAdapter', () => {
  it('sends the rendered Home and returns Telegram’s message ID without a parse mode', async () => {
    const { api, bot } = fakeBot();
    const delivery = new TelegramHomeMessageAdapter();
    delivery.setBot(bot);

    await expect(delivery.send({
      chatId: identity.chatId,
      locale: 'en',
      identity: { ...identity, messageId: undefined } as Omit<HomeIdentity, 'messageId'>,
      screen,
    })).resolves.toEqual({ messageId: 42 });

    expect(api.sendMessage).toHaveBeenCalledWith(identity.chatId, expect.any(String), {
      reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }),
    });
    expect(api.sendMessage.mock.calls[0]?.[2]).not.toHaveProperty('parse_mode');
  });

  it('edits the exact active chat and message without a parse mode', async () => {
    const { api, bot } = fakeBot();
    const delivery = new TelegramHomeMessageAdapter();
    delivery.setBot(bot);

    await delivery.edit({ identity, locale: 'ru', screen });

    expect(api.editMessageText).toHaveBeenCalledWith(identity.chatId, identity.messageId, expect.any(String), {
      reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }),
    });
    expect(api.editMessageText.mock.calls[0]?.[3]).not.toHaveProperty('parse_mode');
  });

  it('strips only reply markup from the exact prior message', async () => {
    const { api, bot } = fakeBot();
    const delivery = new TelegramHomeMessageAdapter();
    delivery.setBot(bot);

    await delivery.stripKeyboard(19, 23);

    expect(api.editMessageReplyMarkup).toHaveBeenCalledWith(19, 23, {
      reply_markup: { inline_keyboard: [] },
    });
    expect(api.editMessageText).not.toHaveBeenCalled();
  });

  it('closes with localized copy and an empty keyboard', async () => {
    const { api, bot } = fakeBot();
    const delivery = new TelegramHomeMessageAdapter();
    delivery.setBot(bot);

    await delivery.closeMessage(19, 23, 'uk');

    expect(api.editMessageText).toHaveBeenCalledWith(19, 23, catalogs.uk.home.recovery.closed, {
      reply_markup: { inline_keyboard: [] },
    });
    expect(api.editMessageText.mock.calls[0]?.[3]).not.toHaveProperty('parse_mode');
  });

  it('propagates Telegram API failures to the use case', async () => {
    const { api, bot } = fakeBot();
    const failure = new Error('network unavailable');
    api.editMessageText.mockRejectedValueOnce(failure);
    const delivery = new TelegramHomeMessageAdapter();
    delivery.setBot(bot);

    await expect(delivery.edit({ identity, locale: 'en', screen })).rejects.toBe(failure);
  });

  it('forgets the Telegram binding when cleared', async () => {
    const { bot } = fakeBot();
    const delivery = new TelegramHomeMessageAdapter();
    delivery.setBot(bot);
    delivery.clearBot();

    await expect(delivery.closeMessage(1, 2, 'en')).rejects.toThrow('Telegram bot is not ready');
  });
});

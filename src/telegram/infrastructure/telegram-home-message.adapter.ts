import { Injectable } from '@nestjs/common';
import type { Bot } from 'grammy';
import { catalogFor } from '../../locales/catalog';
import type { HomeMessageDeliveryPort } from '../application/ports/home-message-delivery.port';
import { renderHomeMessage, type HomeRenderedMessage } from '../interfaces/home-renderer';
import type { TelegramContext } from '../interfaces/telegram-context';

@Injectable()
export class TelegramHomeMessageAdapter implements HomeMessageDeliveryPort {
  private bot?: Bot<TelegramContext>;

  setBot(bot: Bot<TelegramContext>): void {
    this.bot = bot;
  }

  clearBot(): void {
    this.bot = undefined;
  }

  async send(input: Parameters<HomeMessageDeliveryPort['send']>[0]): Promise<{ messageId: number }> {
    const rendered = renderHomeMessage(catalogFor(input.locale), input.identity, input.screen);
    const message = await this.requireBot().api.sendMessage(input.chatId, rendered.text, options(rendered));
    return { messageId: message.message_id };
  }

  async edit(input: Parameters<HomeMessageDeliveryPort['edit']>[0]): Promise<void> {
    const rendered = renderHomeMessage(catalogFor(input.locale), input.identity, input.screen);
    await this.requireBot().api.editMessageText(
      input.identity.chatId,
      input.identity.messageId,
      rendered.text,
      options(rendered),
    );
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.requireBot().api.deleteMessage(chatId, messageId);
  }

  async stripKeyboard(chatId: number, messageId: number): Promise<void> {
    await this.requireBot().api.editMessageReplyMarkup(chatId, messageId, emptyKeyboard());
  }

  async closeMessage(
    chatId: number,
    messageId: number,
    locale: Parameters<HomeMessageDeliveryPort['closeMessage']>[2],
  ): Promise<void> {
    await this.requireBot().api.editMessageText(
      chatId,
      messageId,
      catalogFor(locale).home.recovery.closed,
      emptyKeyboard(),
    );
  }

  private requireBot(): Bot<TelegramContext> {
    if (!this.bot) throw new Error('Telegram bot is not ready');
    return this.bot;
  }
}

function options(rendered: HomeRenderedMessage) {
  return {
    reply_markup: {
      inline_keyboard: rendered.rows.map((row) => row.map((button) => ({
        text: button.text,
        callback_data: button.callbackData,
      }))),
    },
  };
}

function emptyKeyboard() {
  return { reply_markup: { inline_keyboard: [] } };
}

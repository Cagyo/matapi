import { Inject, Injectable, Logger } from '@nestjs/common';
import { Bot } from 'grammy';
import { catalogFor } from '../../locales';
import type { Locale } from '../domain/locale';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';

const RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;

@Injectable()
export class BotCommandsMenuService {
  private readonly logger = new Logger(BotCommandsMenuService.name);
  private readonly queuedUpdates = new Map<number, Promise<void>>();
  private bot: Bot | null = null;

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  setBot(bot: Bot): void {
    this.bot = bot;
  }

  clearBot(): void {
    this.bot = null;
  }

  getUserCommands(locale: Locale = 'en') {
    return catalogFor(locale).commands
      .filter((command) => command.scope === 'user' || command.command === 'settings')
      .map(({ command, description }) => ({ command, description }));
  }

  getAdminCommands(locale: Locale = 'en') {
    return catalogFor(locale).commands.map(({ command, description }) => ({ command, description }));
  }

  updateUserMenu(telegramId: number): Promise<void> {
    if (!this.bot) return Promise.resolve();
    const previous = this.queuedUpdates.get(telegramId) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(() => this.updateCurrentUserMenu(telegramId));
    const tracked = queued.finally(() => {
      if (this.queuedUpdates.get(telegramId) === tracked) {
        this.queuedUpdates.delete(telegramId);
      }
    });
    this.queuedUpdates.set(telegramId, tracked);
    return tracked;
  }

  async syncAllUsers(): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.setMyCommands(this.getUserCommands('en'), {
        scope: { type: 'all_private_chats' },
      });
    } catch (err) {
      this.logger.warn(`Failed to set default private chat commands: ${(err as Error).message}`);
    }

    try {
      const recipients = await this.users.listRecipients();
      await Promise.all(recipients.map(({ telegramId }) => this.updateUserMenu(telegramId)));
    } catch (err) {
      this.logger.warn(`Failed to sync user menus: ${(err as Error).message}`);
    }
  }

  private async updateCurrentUserMenu(telegramId: number): Promise<void> {
    const user = await this.users.findByTelegramId(telegramId);
    if (!user || !this.bot) return;
    const commands = user.role === 'admin'
      ? this.getAdminCommands(user.locale)
      : this.getUserCommands(user.locale);

    for (const delayMs of [0, ...RETRY_DELAYS_MS]) {
      if (delayMs > 0) await this.delay(delayMs);
      try {
        await this.bot.api.setMyCommands(commands, {
          scope: { type: 'chat', chat_id: telegramId },
        });
        return;
      } catch (err) {
        this.logger.warn(`Failed to update a user command menu: ${(err as Error).message}`);
      }
    }
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

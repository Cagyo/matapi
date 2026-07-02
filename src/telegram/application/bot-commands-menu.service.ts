import { Inject, Injectable, Logger } from '@nestjs/common';
import { Bot } from 'grammy';
import { en } from '../../locales/en';
import { Role } from '../domain/role';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';

@Injectable()
export class BotCommandsMenuService {
  private readonly logger = new Logger(BotCommandsMenuService.name);
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

  getUserCommands() {
    return en.commands
      .filter((c) => c.scope === 'user')
      .map((c) => ({
        command: c.command,
        description: c.description,
      }));
  }

  getAdminCommands() {
    return en.commands.map((c) => ({
      command: c.command,
      description: c.description,
    }));
  }

  async updateUserMenu(telegramId: number, role: Role): Promise<void> {
    if (!this.bot) return;
    const commands =
      role === 'admin' ? this.getAdminCommands() : this.getUserCommands();
    try {
      await this.bot.api.setMyCommands(commands, {
        scope: { type: 'chat', chat_id: telegramId },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to update menu for user ${telegramId} (${role}): ${(err as Error).message}`,
      );
    }
  }

  async syncAllUsers(): Promise<void> {
    if (!this.bot) return;

    try {
      await this.bot.api.setMyCommands(this.getUserCommands(), {
        scope: { type: 'all_private_chats' },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to set default private chat commands: ${(err as Error).message}`,
      );
    }

    try {
      const recipients = await this.users.listRecipients();
      for (const recipient of recipients) {
        await this.updateUserMenu(recipient.telegramId, recipient.role);
      }
    } catch (err) {
      this.logger.warn(`Failed to sync user menus: ${(err as Error).message}`);
    }
  }
}

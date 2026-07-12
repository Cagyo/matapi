import { Inject, Injectable } from '@nestjs/common';
import { NextFunction } from 'grammy';
import { catalogFor } from '../../locales';
import { normalizeLocale } from '../domain/locale';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';
import { TelegramContext } from './telegram-context';

@Injectable()
export class LocaleMiddleware {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  /** Resolve a registered sender or stop the handler chain silently. */
  resolveRegistered = async (
    ctx: TelegramContext,
    next: NextFunction,
  ): Promise<void> => {
    if (!(await this.resolve(ctx))) return;
    await next();
  };

  /** Resolve a sender when registered, while preserving pre-registration paths. */
  resolveOptional = async (
    ctx: TelegramContext,
    next: NextFunction,
  ): Promise<void> => {
    await this.resolve(ctx);
    await next();
  };

  private async resolve(ctx: TelegramContext): Promise<boolean> {
    const telegramId = ctx.from?.id;
    if (!telegramId) return false;

    const user = await this.users.findByTelegramId(telegramId);
    if (!user) return false;

    const locale = normalizeLocale(user.locale);
    ctx.localeState = {
      user: { ...user, locale },
      locale,
      catalog: catalogFor(locale),
    };
    return true;
  }
}

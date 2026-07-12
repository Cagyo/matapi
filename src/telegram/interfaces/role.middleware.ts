import { Injectable, Logger } from '@nestjs/common';
import { NextFunction } from 'grammy';
import { TelegramContext } from './telegram-context';

/**
 * GrammY guards that consume locale state resolved earlier in the middleware
 * chain. They intentionally never load a user themselves.
 */
@Injectable()
export class RoleMiddleware {
  private readonly logger = new Logger(RoleMiddleware.name);

  /** Reject unregistered users silently — bot does not respond. */
  registered = async (
    ctx: TelegramContext,
    next: NextFunction,
  ): Promise<void> => {
    if (!ctx.localeState) return;
    await next();
  };

  /** Reject non-admins with a locale reply. */
  adminOnly = async (
    ctx: TelegramContext,
    next: NextFunction,
  ): Promise<void> => {
    const localeState = ctx.localeState;
    if (!localeState) return;
    if (localeState.user.role !== 'admin') {
      try {
        await ctx.reply(localeState.catalog.common.adminRequired);
      } catch (err) {
        this.logger.warn(`adminOnly reply failed: ${(err as Error).message}`);
      }
      return;
    }
    await next();
  };
}

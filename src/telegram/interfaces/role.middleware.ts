import { Inject, Injectable, Logger } from '@nestjs/common';
import { Context, NextFunction } from 'grammy';
import { en } from '../../locales/en';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';
import { Role } from '../domain/role';

/**
 * grammY middleware factory. Depends on `UserRepositoryPort` — never on
 * Drizzle directly (spec 06 / docs/architecture.md → Anti-patterns).
 */
@Injectable()
export class RoleMiddleware {
  private readonly logger = new Logger(RoleMiddleware.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  /** Reject unregistered users silently — bot does not respond. */
  registered = async (ctx: Context, next: NextFunction): Promise<void> => {
    const id = ctx.from?.id;
    if (!id) return;
    const user = await this.users.findByTelegramId(id);
    if (!user) return;
    return next();
  };

  /** Reject non-admins with a locale reply. */
  adminOnly = async (ctx: Context, next: NextFunction): Promise<void> => {
    const id = ctx.from?.id;
    if (!id) return;
    const user = await this.users.findByTelegramId(id);
    if (user?.role !== 'admin') {
      try {
        await ctx.reply(en.common.adminRequired);
      } catch (err) {
        this.logger.warn(`adminOnly reply failed: ${(err as Error).message}`);
      }
      return;
    }
    return next();
  };

  /** Resolve the role of the current sender, or `null` when unregistered. */
  async resolveRole(telegramId: number): Promise<Role | null> {
    const user = await this.users.findByTelegramId(telegramId);
    return user?.role ?? null;
  }
}

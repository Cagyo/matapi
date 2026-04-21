import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Context, NextFunction } from 'grammy';
import { DB, AppDatabase } from '../../database/database.module';
import { users } from '../../database/schema';
import { en } from '../../locales/en';

@Injectable()
export class RoleGuard {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  /** Reject anyone who is not registered. */
  registered = async (ctx: Context, next: NextFunction): Promise<void> => {
    const id = ctx.from?.id;
    if (!id) return;
    const user = this.db.select().from(users).where(eq(users.telegramId, id)).get();
    if (!user) return; // silent ignore
    return next();
  };

  /** Admin-only middleware. */
  adminOnly = async (ctx: Context, next: NextFunction): Promise<void> => {
    const id = ctx.from?.id;
    if (!id) return;
    const user = this.db.select().from(users).where(eq(users.telegramId, id)).get();
    if (!user || user.role !== 'admin') {
      await ctx.reply(en.common.adminRequired);
      return;
    }
    return next();
  };
}

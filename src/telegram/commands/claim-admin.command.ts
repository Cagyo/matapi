import { Inject, Injectable, Logger } from '@nestjs/common';
import { count, eq } from 'drizzle-orm';
import { Bot, Context } from 'grammy';
import { DB, AppDatabase } from '../../database/database.module';
import { users } from '../../database/schema';
import { en } from '../../locales/en';

/**
 * /claim_admin: first user to send wins. Disabled afterwards.
 */
@Injectable()
export class ClaimAdminCommand {
  private readonly logger = new Logger(ClaimAdminCommand.name);

  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  register(bot: Bot): void {
    bot.command('claim_admin', async (ctx: Context) => {
      const from = ctx.from;
      if (!from) return;

      const [{ value: existing }] = this.db
        .select({ value: count() })
        .from(users)
        .all();

      if (existing > 0) {
        await ctx.reply(en.claim.alreadyClaimed);
        return;
      }

      this.db
        .insert(users)
        .values({
          telegramId: from.id,
          name: from.first_name || from.username || `user-${from.id}`,
          role: 'admin',
          createdAt: new Date(),
        })
        .onConflictDoUpdate({
          target: users.telegramId,
          set: { role: 'admin' },
        })
        .run();

      this.logger.log('Admin claimed');
      await ctx.reply(en.claim.success);
    });
  }

  hasAdmin(): boolean {
    const [{ value }] = this.db.select({ value: count() }).from(users).all();
    return value > 0;
  }

  getAdmins(): number[] {
    return this.db
      .select({ id: users.telegramId })
      .from(users)
      .where(eq(users.role, 'admin'))
      .all()
      .map((r) => r.id);
  }
}

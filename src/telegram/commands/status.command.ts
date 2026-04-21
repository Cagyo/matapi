import { Inject, Injectable } from '@nestjs/common';
import { Bot } from 'grammy';
import { eq } from 'drizzle-orm';
import { DB, AppDatabase } from '../../database/database.module';
import { sensors } from '../../database/schema';
import { en } from '../../locales/en';
import { RoleGuard } from '../guards/role.guard';

@Injectable()
export class StatusCommand {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    private readonly guard: RoleGuard,
  ) {}

  register(bot: Bot): void {
    bot.command('status', this.guard.registered, async (ctx) => {
      const rows = this.db.select().from(sensors).where(eq(sensors.enabled, true)).all();
      if (rows.length === 0) {
        await ctx.reply(en.status.none);
        return;
      }
      const lines = rows.map((r) =>
        en.status.line(
          r.name,
          r.lastValue ?? '—',
          r.lastValueAt ? r.lastValueAt.toISOString() : 'never',
        ),
      );
      await ctx.reply(`${en.status.header}\n${lines.join('\n')}`);
    });
  }
}

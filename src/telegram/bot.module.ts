import { Module } from '@nestjs/common';
import { EventModule } from '../events/event.module';
import { BotService } from './bot.service';
import { RoleGuard } from './guards/role.guard';
import { ClaimAdminCommand } from './commands/claim-admin.command';
import { StatusCommand } from './commands/status.command';
import { PingCommand } from './commands/ping.command';
import { HelpCommand } from './commands/help.command';
import { TelegramNotifierAdapter } from './infrastructure/telegram-notifier.adapter';

@Module({
  imports: [EventModule],
  providers: [
    BotService,
    RoleGuard,
    ClaimAdminCommand,
    StatusCommand,
    PingCommand,
    HelpCommand,
    TelegramNotifierAdapter,
  ],
  exports: [BotService],
})
export class BotModule {}

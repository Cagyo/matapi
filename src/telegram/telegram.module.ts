import { Module } from '@nestjs/common';
import { EventModule } from '../events/event.module';
import { SensorModule } from '../sensors/sensor.module';
import { ClaimAdminUseCase } from './application/claim-admin.use-case';
import { USER_REPOSITORY } from './domain/ports/user-repository.port';
import { ConsoleNotifierAdapter } from './infrastructure/console-notifier.adapter';
import { DrizzleUserRepository } from './infrastructure/drizzle-user.repository';
import { GrammyBotGateway, BOT_MODE, BotMode } from './infrastructure/grammy-bot.gateway';
import { InMemoryUserRepository } from './infrastructure/in-memory-user.repository';
import { TelegramNotifierAdapter } from './infrastructure/telegram-notifier.adapter';
import { ClaimAdminHandler } from './interfaces/claim-admin.handler';
import { HelpHandler } from './interfaces/help.handler';
import { PingHandler } from './interfaces/ping.handler';
import { RoleMiddleware } from './interfaces/role.middleware';
import { StatusHandler } from './interfaces/status.handler';

function resolveBotMode(): BotMode {
  if (process.env.BOT_MODE === 'mock') return 'mock';
  if (process.env.BOT_MODE === 'real') return 'real';
  return process.env.TELEGRAM_BOT_TOKEN ? 'real' : 'mock';
}

const mode = resolveBotMode();

/**
 * Telegram composition root — spec 06.
 *
 * Mode selection (resolved once at boot):
 *   - `BOT_MODE=mock` → `InMemoryUserRepository`. Bot disabled.
 *   - `BOT_MODE=real` or `TELEGRAM_BOT_TOKEN` set → `DrizzleUserRepository`.
 *   - Default (no env): mock when token missing, real when token set.
 *
 * The grammY bot itself is constructed by `GrammyBotGateway` only in real
 * mode. In mock mode the gateway binds `ConsoleNotifierAdapter` to the
 * event pipeline so drains succeed locally without a Telegram token.
 */
@Module({
  imports: [EventModule, SensorModule],
  providers: [
    { provide: BOT_MODE, useValue: mode },
    {
      provide: USER_REPOSITORY,
      useClass: mode === 'mock' ? InMemoryUserRepository : DrizzleUserRepository,
    },
    ClaimAdminUseCase,
    RoleMiddleware,
    ClaimAdminHandler,
    StatusHandler,
    PingHandler,
    HelpHandler,
    TelegramNotifierAdapter,
    ConsoleNotifierAdapter,
    GrammyBotGateway,
  ],
  exports: [GrammyBotGateway, USER_REPOSITORY],
})
export class TelegramModule {}

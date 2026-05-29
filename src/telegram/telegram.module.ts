import { Module } from '@nestjs/common';
import { EventModule } from '../events/event.module';
import { SensorModule } from '../sensors/sensor.module';
import { SystemModule } from '../system/system.module';
import { ClaimAdminUseCase } from './application/claim-admin.use-case';
import { DemoteUserUseCase } from './application/demote-user.use-case';
import {
  INVITE_CODE_GENERATOR,
  InviteUseCase,
  defaultInviteCodeGenerator,
} from './application/invite.use-case';
import { PromoteUserUseCase } from './application/promote-user.use-case';
import { RegisterUserUseCase } from './application/register-user.use-case';
import { DIRECT_MESSENGER } from './domain/ports/direct-messenger.port';
import { INVITE_CODE_REPOSITORY } from './domain/ports/invite-code-repository.port';
import { USER_REPOSITORY } from './domain/ports/user-repository.port';
import { ConsoleNotifierAdapter } from './infrastructure/console-notifier.adapter';
import { DrizzleInviteCodeRepository } from './infrastructure/drizzle-invite-code.repository';
import { DrizzleUserRepository } from './infrastructure/drizzle-user.repository';
import { GrammyBotGateway, BOT_MODE, BotMode } from './infrastructure/grammy-bot.gateway';
import { InMemoryInviteCodeRepository } from './infrastructure/in-memory-invite-code.repository';
import { InMemoryUserRepository } from './infrastructure/in-memory-user.repository';
import { TelegramDirectMessenger } from './infrastructure/telegram-direct-messenger.adapter';
import { TelegramNotifierAdapter } from './infrastructure/telegram-notifier.adapter';
import { ClaimAdminHandler } from './interfaces/claim-admin.handler';
import { ConfigHandler } from './interfaces/config.handler';
import { DemoteHandler } from './interfaces/demote.handler';
import { HealthHandler } from './interfaces/health.handler';
import { HelpHandler } from './interfaces/help.handler';
import { InviteHandler } from './interfaces/invite.handler';
import { LogsHandler } from './interfaces/logs.handler';
import { PingHandler } from './interfaces/ping.handler';
import { PromoteHandler } from './interfaces/promote.handler';
import { RoleMiddleware } from './interfaces/role.middleware';
import { StartHandler } from './interfaces/start.handler';
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
 *   - `BOT_MODE=mock` → in-memory user / invite repositories. Bot disabled.
 *   - `BOT_MODE=real` or `TELEGRAM_BOT_TOKEN` set → Drizzle repositories.
 *   - Default (no env): mock when token missing, real when token set.
 *
 * The grammY bot itself is constructed by `GrammyBotGateway` only in real
 * mode. In mock mode the gateway binds `ConsoleNotifierAdapter` to the
 * event pipeline so drains succeed locally without a Telegram token; the
 * `TelegramDirectMessenger` falls back to logging in the same regime.
 */
@Module({
  imports: [EventModule, SensorModule, SystemModule],
  providers: [
    { provide: BOT_MODE, useValue: mode },
    {
      provide: USER_REPOSITORY,
      useClass: mode === 'mock' ? InMemoryUserRepository : DrizzleUserRepository,
    },
    {
      provide: INVITE_CODE_REPOSITORY,
      useClass:
        mode === 'mock'
          ? InMemoryInviteCodeRepository
          : DrizzleInviteCodeRepository,
    },
    { provide: INVITE_CODE_GENERATOR, useValue: defaultInviteCodeGenerator },
    TelegramDirectMessenger,
    { provide: DIRECT_MESSENGER, useExisting: TelegramDirectMessenger },
    ClaimAdminUseCase,
    InviteUseCase,
    RegisterUserUseCase,
    PromoteUserUseCase,
    DemoteUserUseCase,
    RoleMiddleware,
    ClaimAdminHandler,
    StatusHandler,
    PingHandler,
    HelpHandler,
    LogsHandler,
    HealthHandler,
    ConfigHandler,
    InviteHandler,
    StartHandler,
    PromoteHandler,
    DemoteHandler,
    TelegramNotifierAdapter,
    ConsoleNotifierAdapter,
    GrammyBotGateway,
  ],
  exports: [GrammyBotGateway, USER_REPOSITORY],
})
export class TelegramModule {}

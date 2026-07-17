import { Module } from '@nestjs/common';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CameraModule } from '../camera/camera.module';
import { ConfigModule } from '../config/config.module';
import { EventModule } from '../events/event.module';
import { FeatureModule } from '../features/feature.module';
import { NetworkModule } from '../network/network.module';
import { SensorModule } from '../sensors/sensor.module';
import { SystemModule } from '../system/system.module';
import { ClaimAdminUseCase } from './application/claim-admin.use-case';
import { DemoteUserUseCase } from './application/demote-user.use-case';
import {
  INVITE_CODE_GENERATOR,
  InviteUseCase,
  defaultInviteCodeGenerator,
} from './application/invite.use-case';
import { MuteSensorUseCase } from './application/mute-sensor.use-case';
import { PauseNonCriticalNotificationsUseCase } from './application/pause-non-critical-notifications.use-case';
import { ResumeNonCriticalNotificationsUseCase } from './application/resume-non-critical-notifications.use-case';
import { UndoNonCriticalPauseUseCase } from './application/undo-non-critical-pause.use-case';
import { PromoteUserUseCase } from './application/promote-user.use-case';
import { ResolveUserTargetUseCase } from './application/resolve-user-target.use-case';
import { RegisterUserUseCase } from './application/register-user.use-case';
import { RestartConfirmationService } from './interfaces/restart-confirmation.service';
import { SystemOnlineNotifier } from './application/system-online-notifier.service';
import { RefreshHomeMonitoringUseCase } from './application/refresh-home-monitoring.use-case';
import { GetHomeSummaryUseCase } from './application/get-home-summary.use-case';
import { GetHomeScreenUseCase } from './application/get-home-screen.use-case';
import { GetNotificationScreenUseCase } from './application/get-notification-screen.use-case';
import { NotificationTargetDirectoryService } from './application/notification-target-directory.service';
import { SetNotificationTargetMutedUseCase } from './application/set-notification-target-muted.use-case';
import { OpenHomeUseCase } from './application/open-home.use-case';
import { RenderHomeUseCase } from './application/render-home.use-case';
import { ValidateHomeCallbackUseCase } from './application/validate-home-callback.use-case';
import { RestartSystemUseCase } from './application/restart-system.use-case';
import { RollbackSystemUseCase } from './application/rollback-system.use-case';
import { SetQuietHoursUseCase } from './application/set-quiet-hours.use-case';
import { CompareAndSetQuietHoursUseCase } from './application/compare-and-set-quiet-hours.use-case';
import { SetAutoCleanThresholdUseCase } from './application/set-auto-clean-threshold.use-case';
import { HomeNavigationUseCase } from './application/home-navigation.use-case';
import { BeginWorkflowReturnUseCase } from './application/begin-workflow-return.use-case';
import { ClaimWorkflowReturnUseCase } from './application/claim-workflow-return.use-case';
import { CompleteWorkflowReturnUseCase } from './application/complete-workflow-return.use-case';
import { ResolveWorkflowOriginUseCase } from './application/resolve-workflow-origin.use-case';
import { RestoreWorkflowOriginUseCase } from './application/restore-workflow-origin.use-case';
import { UpdateWorkflowReturnUseCase } from './application/update-workflow-return.use-case';
import { SystemUpdateUseCase } from './application/system-update.use-case';
import { UnmuteSensorUseCase } from './application/unmute-sensor.use-case';
import { UpdateSystemUseCase } from './application/update-system.use-case';
import { ExportConfigUseCase } from './application/export-config.use-case';
import { ImportCameraLiveSourcesUseCase } from './application/import-camera-live-sources.use-case';
import { StageCsvExportUseCase } from './application/stage-csv-export.use-case';
import {
  CSV_TEMP_DIRECTORY,
  CSV_TEMP_FILE,
} from './application/ports/csv-temp-file.port';
import { ADMIN_CLAIM_CREDENTIAL } from './domain/ports/admin-claim-credential.port';
import { DIRECT_MESSENGER } from './domain/ports/direct-messenger.port';
import { CONFIG_CODEC } from './domain/ports/config-codec.port';
import { INVITE_CODE_REPOSITORY } from './domain/ports/invite-code-repository.port';
import { NOTIFICATION_PAUSE_REPOSITORY } from './domain/ports/notification-pause-repository.port';
import { USER_REPOSITORY } from './domain/ports/user-repository.port';
import { USER_SENSOR_MUTE_REPOSITORY } from './domain/ports/user-sensor-mute-repository.port';
import { HOME_SESSION_STORE } from './domain/ports/home-session-store.port';
import { HOME_TOKEN_GENERATOR } from './domain/ports/home-token-generator.port';
import { HOME_HEALTH_SNAPSHOT } from './application/ports/home-health-snapshot.port';
import { HOME_MESSAGE_DELIVERY } from './application/ports/home-message-delivery.port';
import { HOME_ACTION_REPOSITORY } from './application/ports/home-action-repository.port';
import { ConsoleNotifierAdapter } from './infrastructure/console-notifier.adapter';
import { EnvAdminClaimCredentialAdapter } from './infrastructure/env-admin-claim-credential.adapter';
import { TelegramAdminAlertAdapter } from './infrastructure/telegram-admin-alert.adapter';
import { TelegramLiveStreamMessageCleanupAdapter } from './infrastructure/telegram-live-stream-message-cleanup.adapter';
import { DrizzleInviteCodeRepository } from './infrastructure/drizzle-invite-code.repository';
import { DrizzleUserRepository } from './infrastructure/drizzle-user.repository';
import { DrizzleUserSensorMuteRepository } from './infrastructure/drizzle-user-sensor-mute.repository';
import { DrizzleHomeSessionStore } from './infrastructure/drizzle-home-session.store';
import { DrizzleHomeActionRepository } from './infrastructure/drizzle-home-action.repository';
import { GrammyBotGateway, BOT_MODE, BotMode } from './infrastructure/grammy-bot.gateway';
import { InMemoryInviteCodeRepository } from './infrastructure/in-memory-invite-code.repository';
import { InMemoryUserRepository } from './infrastructure/in-memory-user.repository';
import { InMemoryUserSensorMuteRepository } from './infrastructure/in-memory-user-sensor-mute.repository';
import { InMemoryHomeSessionStore } from './infrastructure/in-memory-home-session.store';
import { InMemoryHomeActionRepository } from './infrastructure/in-memory-home-action.repository';
import { InMemoryHomeHealthSnapshotAdapter } from './infrastructure/in-memory-home-health-snapshot.adapter';
import { InMemoryHomeMessageDeliveryAdapter } from './infrastructure/in-memory-home-message-delivery.adapter';
import { TelegramHomeMessageAdapter } from './infrastructure/telegram-home-message.adapter';
import { CryptoHomeTokenGenerator } from './infrastructure/crypto-home-token-generator.adapter';
import { TelegramDirectMessenger } from './infrastructure/telegram-direct-messenger.adapter';
import { TelegramNotifierAdapter } from './infrastructure/telegram-notifier.adapter';
import { TelegramRecipientDirectoryAdapter } from './infrastructure/telegram-recipient-directory.adapter';
import { YamlConfigCodec } from './infrastructure/yaml-config-codec.adapter';
import { NodeCsvTempFileAdapter } from './infrastructure/node-csv-temp-file.adapter';
import { ClaimAdminHandler } from './interfaces/claim-admin.handler';
import { CameraHandler } from './interfaces/camera.handler';
import { CameraSourcesHandler } from './interfaces/camera-sources.handler';
import { CsvHandler } from './interfaces/csv.handler';
import { ConfigHandler } from './interfaces/config.handler';
import { DemoteHandler } from './interfaces/demote.handler';
import { ExportConfigHandler } from './interfaces/export-config.handler';
import { FeatureHandler } from './interfaces/feature.handler';
import { GdriveHandler } from './interfaces/gdrive.handler';
import { GdriveAuthHandler } from './interfaces/gdrive-auth.handler';
import { HealthHandler } from './interfaces/health.handler';
import { HelpHandler } from './interfaces/help.handler';
import { ImportConfigHandler } from './interfaces/import-config.handler';
import { InviteHandler } from './interfaces/invite.handler';
import { LogsHandler } from './interfaces/logs.handler';
import { MuteHandler } from './interfaces/mute.handler';
import { PingHandler } from './interfaces/ping.handler';
import { PromoteHandler } from './interfaces/promote.handler';
import { QuietHoursHandler } from './interfaces/quiet-hours.handler';
import { RestartHandler } from './interfaces/restart.handler';
import { RoleMiddleware } from './interfaces/role.middleware';
import { LocaleMiddleware } from './interfaces/locale.middleware';
import { RollbackHandler } from './interfaces/rollback.handler';
import { StartHandler } from './interfaces/start.handler';
import { StatusHandler } from './interfaces/status.handler';
import { SystemUpdateHandler } from './interfaces/system-update.handler';
import { UnmuteHandler } from './interfaces/unmute.handler';
import { UpdateHandler } from './interfaces/update.handler';
import { HomeHandler } from './interfaces/home.handler';
import { HomeLauncher } from './interfaces/home-launcher';
import { LegacyMenuHandler } from './interfaces/legacy-menu.handler';
import { SettingsHandler } from './interfaces/settings.handler';
import { CleanHandler } from './interfaces/clean.handler';
import { BotCommandsMenuService } from './application/bot-commands-menu.service';
import { WorkflowDraftRegistry } from './interfaces/workflow-draft.registry';
import { WorkflowOperationQueue } from './interfaces/workflow-operation.queue';
import { WorkflowEntryCoordinator } from './interfaces/workflow-entry.coordinator';
import { WorkflowNavigationHandler } from './interfaces/workflow-navigation.handler';
import { WorkflowNavigationPresenter } from './interfaces/workflow-navigation.presenter';

function resolveBotMode(): BotMode {
  if (process.env.BOT_MODE === 'mock') return 'mock';
  if (process.env.BOT_MODE === 'real') return 'real';
  if (process.env.NODE_ENV === 'test') return 'mock';
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
  imports: [
    ConfigModule,
    EventModule,
    SensorModule,
    SystemModule,
    CameraModule,
    FeatureModule,
    NetworkModule,
  ],
  providers: [
    { provide: BOT_MODE, useValue: mode },
    {
      provide: ADMIN_CLAIM_CREDENTIAL,
      useClass: EnvAdminClaimCredentialAdapter,
    },
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
    {
      provide: USER_SENSOR_MUTE_REPOSITORY,
      useClass:
        mode === 'mock'
          ? InMemoryUserSensorMuteRepository
          : DrizzleUserSensorMuteRepository,
    },
    {
      provide: HOME_SESSION_STORE,
      useClass: mode === 'mock' ? InMemoryHomeSessionStore : DrizzleHomeSessionStore,
    },
    {
      provide: HOME_ACTION_REPOSITORY,
      ...(mode === 'mock'
        ? {
          useFactory: (users: InMemoryUserRepository) => new InMemoryHomeActionRepository(users),
          inject: [USER_REPOSITORY],
        }
        : { useClass: DrizzleHomeActionRepository }),
    },
    { provide: HOME_TOKEN_GENERATOR, useClass: CryptoHomeTokenGenerator },
    {
      provide: HOME_MESSAGE_DELIVERY,
      useClass: mode === 'mock'
        ? InMemoryHomeMessageDeliveryAdapter
        : TelegramHomeMessageAdapter,
    },
    InMemoryHomeHealthSnapshotAdapter,
    { provide: HOME_HEALTH_SNAPSHOT, useExisting: InMemoryHomeHealthSnapshotAdapter },
    { provide: INVITE_CODE_GENERATOR, useValue: defaultInviteCodeGenerator },
    // One repository instance serves both the recipient reads and the pause
    // mutations so their state cannot diverge. Foundation only — no handler,
    // command, callback, or menu action is wired in this slice.
    { provide: NOTIFICATION_PAUSE_REPOSITORY, useExisting: USER_REPOSITORY },
    PauseNonCriticalNotificationsUseCase,
    ResumeNonCriticalNotificationsUseCase,
    UndoNonCriticalPauseUseCase,
    TelegramDirectMessenger,
    { provide: DIRECT_MESSENGER, useExisting: TelegramDirectMessenger },
    ClaimAdminUseCase,
    InviteUseCase,
    RegisterUserUseCase,
    ResolveUserTargetUseCase,
    PromoteUserUseCase,
    DemoteUserUseCase,
    MuteSensorUseCase,
    UnmuteSensorUseCase,
    SetQuietHoursUseCase,
    CompareAndSetQuietHoursUseCase,
    SetAutoCleanThresholdUseCase,
    HomeNavigationUseCase,
    BeginWorkflowReturnUseCase,
    UpdateWorkflowReturnUseCase,
    ClaimWorkflowReturnUseCase,
    CompleteWorkflowReturnUseCase,
    ResolveWorkflowOriginUseCase,
    RestoreWorkflowOriginUseCase,
    UpdateSystemUseCase,
    SystemUpdateUseCase,
    RollbackSystemUseCase,
    RestartSystemUseCase,
    RestartConfirmationService,
    SystemOnlineNotifier,
    RefreshHomeMonitoringUseCase,
    GetHomeSummaryUseCase,
    GetNotificationScreenUseCase,
    NotificationTargetDirectoryService,
    SetNotificationTargetMutedUseCase,
    GetHomeScreenUseCase,
    ValidateHomeCallbackUseCase,
    OpenHomeUseCase,
    RenderHomeUseCase,
    BotCommandsMenuService,
    ExportConfigUseCase,
    ImportCameraLiveSourcesUseCase,
    StageCsvExportUseCase,
    { provide: CONFIG_CODEC, useClass: YamlConfigCodec },
    { provide: CSV_TEMP_DIRECTORY, useValue: join(tmpdir(), 'home-worker-csv') },
    LocaleMiddleware,
    { provide: CSV_TEMP_FILE, useClass: NodeCsvTempFileAdapter },
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
    MuteHandler,
    UnmuteHandler,
    QuietHoursHandler,
    UpdateHandler,
    SystemUpdateHandler,
    RollbackHandler,
    RestartHandler,
    CameraHandler,
    CameraSourcesHandler,
    GdriveHandler,
    GdriveAuthHandler,
    ExportConfigHandler,
    ImportConfigHandler,
    FeatureHandler,
    CsvHandler,
    HomeHandler,
    WorkflowDraftRegistry,
    WorkflowOperationQueue,
    WorkflowEntryCoordinator,
    WorkflowNavigationPresenter,
    WorkflowNavigationHandler,
    HomeLauncher,
    LegacyMenuHandler,
    SettingsHandler,
    CleanHandler,
    TelegramNotifierAdapter,
    ConsoleNotifierAdapter,
    TelegramAdminAlertAdapter,
    TelegramLiveStreamMessageCleanupAdapter,
    TelegramRecipientDirectoryAdapter,
    GrammyBotGateway,
  ],
  exports: [GrammyBotGateway, USER_REPOSITORY, HOME_SESSION_STORE, HOME_ACTION_REPOSITORY, GdriveAuthHandler],
})
export class TelegramModule {}

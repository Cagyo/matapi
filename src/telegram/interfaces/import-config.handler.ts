import { Inject, Injectable, Logger } from '@nestjs/common';
import { CallbackQueryContext, Composer, InlineKeyboard } from 'grammy';
import { en } from '../../locales/en';
import {
  ImportPlan,
  ImportSummary,
  ImportSensorsUseCase,
} from '../../sensors/application/import-sensors.use-case';
import {
  CameraLiveSourceImportPlan,
  ImportCameraLiveSourcesUseCase,
} from '../application/import-camera-live-sources.use-case';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';
import { validateLiveSourceConfig } from '../domain/live-source-config-import';
import { validateImportConfig } from '../../sensors/domain/config-import';
import {
  CONFIG_CODEC,
  ConfigCodecPort,
} from '../domain/ports/config-codec.port';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';

/** Max accepted upload size (spec 16 — guard against huge documents). */
const MAX_FILE_BYTES = 1_000_000;

/**
 * Per-user `/import_config` state (spec 16). In-memory only — lost on restart.
 * State only ever exists for admins, since the command is admin-gated.
 */
type ImportState =
  | { kind: 'awaitingFile' }
  | {
      kind: 'awaitingConfirm';
      sensorPlan: ImportPlan;
      cameraPlan: CameraLiveSourceImportPlan;
    };

/**
 * `/import_config` — spec 16. Admin-only, two-step FSM:
 *  1. Prompt for a `.yml` upload.
 *  2. Validate + diff, show a summary, then Apply/Cancel.
 *
 * Confirmation applies the credential-free camera batch first (one camera DB
 * transaction), rechecks the current admin role, then applies the existing
 * sensor transaction and hot reload. A localized partial-state reply is sent
 * if the second phase cannot run or fails.
 */
@Injectable()
export class ImportConfigHandler implements TelegramHandler {
  private readonly logger = new Logger(ImportConfigHandler.name);
  private readonly states = new Map<number, ImportState>();
  private readonly botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';

  constructor(
    private readonly importSensors: ImportSensorsUseCase,
    private readonly importCameraSources: ImportCameraLiveSourcesUseCase,
    @Inject(CONFIG_CODEC) private readonly codec: ConfigCodecPort,
    private readonly guard: RoleMiddleware,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('import_config', this.guard.adminOnly, (ctx) =>
      this.handleCommand(ctx),
    );
    composer.command('cancel', this.guard.adminOnly, async (ctx) => {
      const userId = ctx.from?.id;
      if (userId && this.states.has(userId)) {
        this.states.delete(userId);
        await ctx.reply(en.importConfig.cancelled);
      } else {
        await ctx.reply(en.common.noActiveWizard);
      }
    });
    composer.callbackQuery(/^imp:/, this.guard.adminOnly, (ctx) =>
      this.onCallback(ctx),
    );
    // Document listener: NOT admin-gated, so non-admins sending unrelated
    // files aren't told "admin required". We only act if this user is mid-import.
    composer.on('message:document', async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || this.states.get(userId)?.kind !== 'awaitingFile') {
        return next();
      }
      await this.onDocument(ctx, userId);
    });
  }

  async handleCommand(ctx: TelegramContext): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    this.states.set(userId, { kind: 'awaitingFile' });
    await ctx.reply(en.importConfig.prompt);
  }

  private async onDocument(ctx: TelegramContext, userId: number): Promise<void> {
    const doc = ctx.message?.document;
    if (!doc) return;

    const name = doc.file_name ?? '';
    if (!/\.ya?ml$/i.test(name)) {
      await ctx.reply(en.importConfig.invalidFormat);
      return; // keep awaitingFile so the user can re-upload
    }

    if (typeof doc.file_size === 'number' && doc.file_size > MAX_FILE_BYTES) {
      await ctx.reply(en.importConfig.tooLarge);
      return;
    }

    let text: string;
    try {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`download failed: ${response.status}`);
      }
      text = await response.text();
    } catch (error) {
      this.logger.error('import_config download failed', error as Error);
      await ctx.reply(en.importConfig.failed('could not download file'));
      this.states.delete(userId);
      return;
    }

    let parsed: unknown;
    try {
      parsed = this.codec.parse(text);
    } catch (error) {
      await ctx.reply(en.importConfig.parseError((error as Error).message));
      return; // keep awaitingFile
    }

    const catalog = ctx.localeState?.catalog ?? en;
    const validation = validateImportConfig(parsed);
    const liveSourceValidation = validateLiveSourceConfig(
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { live_sources?: unknown }).live_sources
        : undefined,
    );
    if (!validation.ok || !liveSourceValidation.ok) {
      const errors = [
        ...(validation.ok ? [] : validation.errors),
        ...(liveSourceValidation.ok
          ? []
          : [catalog.importConfig.invalidLiveSources]),
      ];
      await ctx.reply(catalog.importConfig.validationFailed(errors));
      return; // keep awaitingFile
    }

    let sensorPlan: ImportPlan;
    let cameraPlan: CameraLiveSourceImportPlan;
    try {
      [sensorPlan, cameraPlan] = await Promise.all([
        this.importSensors.prepare(validation.sensors),
        this.importCameraSources.prepare(liveSourceValidation.liveSources),
      ]);
    } catch (error) {
      this.logger.error('import_config prepare failed', error as Error);
      await ctx.reply(catalog.importConfig.applyFailed);
      this.states.delete(userId);
      return;
    }

    const { added, updated, archived } = sensorPlan.summary;
    if (
      added.length === 0 &&
      updated.length === 0 &&
      archived.length === 0 &&
      cameraPlan.configured.length === 0
    ) {
      await ctx.reply(catalog.importConfig.noChanges);
      this.states.delete(userId);
      return;
    }

    this.states.set(userId, {
      kind: 'awaitingConfirm',
      sensorPlan,
      cameraPlan,
    });
    const keyboard = new InlineKeyboard()
      .text(en.importConfig.applyButton, 'imp:apply')
      .text(en.importConfig.cancelButton, 'imp:cancel');
    await ctx.reply(
      catalog.importConfig.summary({
        ...sensorPlan.summary,
        liveSources: [...cameraPlan.configured],
      }),
      {
      reply_markup: keyboard,
      },
    );
  }

  private async onCallback(ctx: CallbackQueryContext<TelegramContext>): Promise<void> {
    const userId = ctx.from?.id;
    const data = ctx.callbackQuery.data;
    const state = userId ? this.states.get(userId) : undefined;
    const claimedState =
      data === 'imp:apply' && state?.kind === 'awaitingConfirm'
        ? state
        : undefined;
    if (userId && (claimedState || data === 'imp:cancel')) {
      this.states.delete(userId);
    }

    await ctx.answerCallbackQuery().catch(() => undefined);
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);

    if (!userId) return;

    if (data === 'imp:cancel') {
      await ctx.reply(en.importConfig.cancelled);
      return;
    }

    if (data === 'imp:apply') {
      if (!claimedState) {
        await ctx.reply(en.common.interrupted);
        return;
      }
      const catalog = ctx.localeState?.catalog ?? en;
      let cameraApplied = false;
      let phase: 'camera' | 'sensor' = 'camera';
      let summary: ImportSummary | undefined;
      let replyText: string | undefined;
      try {
        if (!(await this.isCurrentAdmin(userId))) {
          replyText = catalog.common.adminRequired;
        } else {
          if (claimedState.cameraPlan.configured.length > 0) {
            await this.importCameraSources.commit(claimedState.cameraPlan);
            cameraApplied = true;
          }

          if (!(await this.isCurrentAdmin(userId))) {
            replyText = cameraApplied
              ? catalog.importConfig.partialRoleChanged
              : catalog.common.adminRequired;
          } else {
            phase = 'sensor';
            summary = await this.importSensors.commit(claimedState.sensorPlan);
          }
        }
      } catch (_error) {
        this.logger.error('import_config apply failed');
        replyText =
          phase === 'sensor'
            ? cameraApplied
              ? catalog.importConfig.partialFailed
              : catalog.importConfig.sensorOutcomeUncertain
            : catalog.importConfig.applyFailed;
      }
      if (!replyText && summary) {
        replyText = catalog.importConfig.applied({
          ...summary,
          liveSources: [...claimedState.cameraPlan.configured],
        });
      }
      replyText ??= catalog.importConfig.applyFailed;
      await ctx.reply(replyText).catch(() => {
        this.logger.warn('import_config result reply failed');
      });
    }
  }

  private async isCurrentAdmin(telegramId: number): Promise<boolean> {
    return (await this.users.findByTelegramId(telegramId))?.role === 'admin';
  }
}

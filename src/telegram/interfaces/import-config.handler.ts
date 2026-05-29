import { Inject, Injectable, Logger } from '@nestjs/common';
import { CallbackQueryContext, Composer, Context, InlineKeyboard } from 'grammy';
import { en } from '../../locales/en';
import {
  ImportPlan,
  ImportSensorsUseCase,
} from '../../sensors/application/import-sensors.use-case';
import { validateImportConfig } from '../../sensors/domain/config-import';
import {
  CONFIG_CODEC,
  ConfigCodecPort,
} from '../domain/ports/config-codec.port';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

/** Max accepted upload size (spec 16 — guard against huge documents). */
const MAX_FILE_BYTES = 1_000_000;

/**
 * Per-user `/import_config` state (spec 16). In-memory only — lost on restart.
 * State only ever exists for admins, since the command is admin-gated.
 */
type ImportState =
  | { kind: 'awaitingFile' }
  | { kind: 'awaitingConfirm'; plan: ImportPlan };

/**
 * `/import_config` — spec 16. Admin-only, two-step FSM:
 *  1. Prompt for a `.yml` upload.
 *  2. Validate + diff, show a summary, then Apply/Cancel.
 *
 * Apply is transactional (see `ImportSensorsUseCase.commit`) and hot-reloads
 * the sensor registry.
 */
@Injectable()
export class ImportConfigHandler implements TelegramHandler {
  private readonly logger = new Logger(ImportConfigHandler.name);
  private readonly states = new Map<number, ImportState>();
  private readonly botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';

  constructor(
    private readonly importSensors: ImportSensorsUseCase,
    @Inject(CONFIG_CODEC) private readonly codec: ConfigCodecPort,
    private readonly guard: RoleMiddleware,
  ) {}

  register(composer: Composer<Context>): void {
    composer.command('import_config', this.guard.adminOnly, (ctx) =>
      this.onCommand(ctx),
    );
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

  private async onCommand(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    this.states.set(userId, { kind: 'awaitingFile' });
    await ctx.reply(en.importConfig.prompt);
  }

  private async onDocument(ctx: Context, userId: number): Promise<void> {
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

    const validation = validateImportConfig(parsed);
    if (!validation.ok) {
      await ctx.reply(en.importConfig.validationFailed(validation.errors));
      return; // keep awaitingFile
    }

    let plan: ImportPlan;
    try {
      plan = await this.importSensors.prepare(validation.sensors);
    } catch (error) {
      this.logger.error('import_config prepare failed', error as Error);
      await ctx.reply(en.importConfig.failed((error as Error).message));
      this.states.delete(userId);
      return;
    }

    const { added, updated, archived } = plan.summary;
    if (added.length === 0 && updated.length === 0 && archived.length === 0) {
      await ctx.reply(en.importConfig.noChanges);
      this.states.delete(userId);
      return;
    }

    this.states.set(userId, { kind: 'awaitingConfirm', plan });
    const keyboard = new InlineKeyboard()
      .text(en.importConfig.applyButton, 'imp:apply')
      .text(en.importConfig.cancelButton, 'imp:cancel');
    await ctx.reply(en.importConfig.summary(plan.summary), {
      reply_markup: keyboard,
    });
  }

  private async onCallback(ctx: CallbackQueryContext<Context>): Promise<void> {
    const userId = ctx.from?.id;
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();

    if (!userId) return;
    const state = this.states.get(userId);

    if (data === 'imp:cancel') {
      this.states.delete(userId);
      await ctx.reply(en.importConfig.cancelled);
      return;
    }

    if (data === 'imp:apply') {
      if (state?.kind !== 'awaitingConfirm') {
        await ctx.reply(en.common.interrupted);
        return;
      }
      try {
        const summary = await this.importSensors.commit(state.plan);
        this.states.delete(userId);
        await ctx.reply(en.importConfig.applied(summary));
      } catch (error) {
        this.logger.error('import_config apply failed', error as Error);
        this.states.delete(userId);
        await ctx.reply(en.importConfig.failed((error as Error).message));
      }
    }
  }
}

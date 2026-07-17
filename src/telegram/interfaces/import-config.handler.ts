import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
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
import type { WorkflowReturnReceipt } from '../domain/workflow-return';
import { workflowReturnCallback } from '../domain/workflow-return';
import {
  WorkflowEntryCoordinator,
  type WorkflowLaunch,
} from './workflow-entry.coordinator';
import {
  WorkflowDraftRegistry,
  type WorkflowDraftCanceller,
} from './workflow-draft.registry';
import { WorkflowNavigationHandler } from './workflow-navigation.handler';

/** Max accepted upload size (spec 16 — guard against huge documents). */
const MAX_FILE_BYTES = 1_000_000;

/**
 * Per-user `/import_config` state (spec 16). In-memory only — lost on restart.
 * State only ever exists for admins, since the command is admin-gated.
 */
type ImportStep =
  | { kind: 'awaitingFile' }
  | {
      kind: 'awaitingConfirm';
      sensorPlan: ImportPlan;
    cameraPlan: CameraLiveSourceImportPlan;
  };

type ImportState = ImportStep & {
  userId: number;
  chatId: number;
  receiptId: string;
  receipt: WorkflowReturnReceipt;
};

const IMPORT_CALLBACK = /^imp:([A-Za-z0-9_-]{16}):(a|c)$/;

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
export class ImportConfigHandler implements TelegramHandler, WorkflowDraftCanceller {
  private readonly logger = new Logger(ImportConfigHandler.name);
  private readonly states = new Map<string, ImportState>();
  private readonly botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';

  constructor(
    private readonly importSensors: ImportSensorsUseCase,
    private readonly importCameraSources: ImportCameraLiveSourcesUseCase,
    @Inject(CONFIG_CODEC) private readonly codec: ConfigCodecPort,
    private readonly guard: RoleMiddleware,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    private readonly workflows: WorkflowEntryCoordinator,
    private readonly drafts: WorkflowDraftRegistry,
    @Optional() private readonly navigation?: WorkflowNavigationHandler,
  ) {
    this.drafts.register('sensor-import', this);
  }

  register(composer: Composer<TelegramContext>): void {
    composer.command('import_config', this.guard.adminOnly, (ctx) =>
      this.handleCommand(ctx),
    );
    composer.command('cancel', this.guard.adminOnly, async (ctx, next) => {
      const state = this.stateFor(ctx);
      if (!state) return next();
      await this.complete(ctx, state, () => ctx.reply(this.catalog(ctx).importConfig.cancelled));
    });
    composer.callbackQuery(/^imp:/, this.guard.adminOnly, (ctx) =>
      this.onCallback(ctx),
    );
    // Document listener: NOT admin-gated, so non-admins sending unrelated
    // files aren't told "admin required". We only act if this user is mid-import.
    composer.on('message:document', async (ctx, next) => {
      const state = this.stateFor(ctx);
      if (state?.kind !== 'awaitingFile') {
        return next();
      }
      await this.onDocument(ctx, state);
    });
  }

  async cancelExact(input: {
    userId: number;
    chatId: number;
    receiptId: string;
  }): Promise<'cancelled' | 'missing' | 'superseded'> {
    const state = this.states.get(stateKey(input.userId, input.chatId));
    if (!state) return 'missing';
    if (state.receiptId !== input.receiptId) return 'superseded';
    this.states.delete(stateKey(input.userId, input.chatId));
    return 'cancelled';
  }

  async handleCommand(ctx: TelegramContext, launch?: WorkflowLaunch): Promise<void> {
    const receipt = launch?.receipt ?? await this.workflows.begin(ctx, 'sensor-import', {
      source: 'natural-parent',
    });
    if (!receipt) return;
    const state = this.setState(receipt, { kind: 'awaitingFile' });
    await ctx.reply(this.catalog(ctx).importConfig.prompt, {
      reply_markup: this.keyboard(ctx, state),
    });
  }

  private async onDocument(ctx: TelegramContext, state: ImportState): Promise<void> {
    const doc = ctx.message?.document;
    if (!doc) return;

    const name = doc.file_name ?? '';
    if (!/\.ya?ml$/i.test(name)) {
      await ctx.reply(this.catalog(ctx).importConfig.invalidFormat, {
        reply_markup: this.keyboard(ctx, state),
      });
      return; // keep awaitingFile so the user can re-upload
    }

    if (typeof doc.file_size === 'number' && doc.file_size > MAX_FILE_BYTES) {
      await ctx.reply(this.catalog(ctx).importConfig.tooLarge, {
        reply_markup: this.keyboard(ctx, state),
      });
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
      await this.complete(ctx, state, () => ctx.reply(this.catalog(ctx).importConfig.failed('could not download file')));
      return;
    }

    let parsed: unknown;
    try {
      parsed = this.codec.parse(text);
    } catch (error) {
      await ctx.reply(this.catalog(ctx).importConfig.parseError((error as Error).message), {
        reply_markup: this.keyboard(ctx, state),
      });
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
      await ctx.reply(catalog.importConfig.validationFailed(errors), {
        reply_markup: this.keyboard(ctx, state),
      });
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
      await this.complete(ctx, state, () => ctx.reply(catalog.importConfig.applyFailed));
      return;
    }

    const { added, updated, archived } = sensorPlan.summary;
    if (
      added.length === 0 &&
      updated.length === 0 &&
      archived.length === 0 &&
      cameraPlan.configured.length === 0
    ) {
      await this.complete(ctx, state, () => ctx.reply(catalog.importConfig.noChanges));
      return;
    }

    const confirmation = this.setState(state.receipt, {
      kind: 'awaitingConfirm',
      sensorPlan,
      cameraPlan,
    });
    const keyboard = new InlineKeyboard()
      .text(catalog.importConfig.applyButton, importCallback(confirmation.receiptId, 'a'))
      .text(catalog.importConfig.cancelButton, importCallback(confirmation.receiptId, 'c'));
    await ctx.reply(
      catalog.importConfig.summary({
        ...sensorPlan.summary,
        liveSources: [...cameraPlan.configured],
      }),
      {
      reply_markup: this.keyboard(ctx, confirmation, keyboard),
      },
    );
  }

  private async onCallback(ctx: CallbackQueryContext<TelegramContext>): Promise<void> {
    const parsed = parseImportCallback(ctx.callbackQuery.data ?? '');
    await ctx.answerCallbackQuery().catch(() => undefined);
    const state = this.stateFor(ctx);
    if (!parsed || !state) return;
    if (parsed.receiptId !== state.receiptId || state.kind !== 'awaitingConfirm') return;
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);

    if (parsed.action === 'c') {
      await this.complete(ctx, state, () => ctx.reply(this.catalog(ctx).importConfig.cancelled));
      return;
    }

    if (parsed.action === 'a') {
      const claimedState = state;
      // Claim local state before any async work so a duplicate Apply callback
      // cannot start a second import while authorization is in flight.
      await this.cancelExact({
        userId: claimedState.userId,
        chatId: claimedState.chatId,
        receiptId: claimedState.receiptId,
      });
      const catalog = ctx.localeState?.catalog ?? en;
      let cameraApplied = false;
      let phase: 'camera' | 'sensor' = 'camera';
      let summary: ImportSummary | undefined;
      let replyText: string | undefined;
      try {
        if (!(await this.isCurrentAdmin(claimedState.userId))) {
          replyText = catalog.common.adminRequired;
        } else {
          if (claimedState.cameraPlan.configured.length > 0) {
            await this.importCameraSources.commit(claimedState.cameraPlan);
            cameraApplied = true;
          }

          if (!(await this.isCurrentAdmin(claimedState.userId))) {
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
      await this.complete(ctx, claimedState, () => ctx.reply(replyText)).catch(() => {
        this.logger.warn('import_config result reply failed');
      });
    }
  }

  private async isCurrentAdmin(telegramId: number): Promise<boolean> {
    return (await this.users.findByTelegramId(telegramId))?.role === 'admin';
  }

  private setState(receipt: WorkflowReturnReceipt, step: ImportStep): ImportState {
    const state: ImportState = {
      ...step,
      userId: receipt.userId,
      chatId: receipt.chatId,
      receiptId: receipt.id,
      receipt,
    };
    this.states.set(stateKey(state.userId, state.chatId), state);
    return state;
  }

  private stateFor(ctx: TelegramContext): ImportState | null {
    const userId = ctx.from?.id;
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || ctx.chat?.type !== 'private') return null;
    return this.states.get(stateKey(userId, ctx.chat.id)) ?? null;
  }

  private catalog(ctx: TelegramContext) {
    return ctx.localeState?.catalog ?? en;
  }

  private keyboard(
    ctx: TelegramContext,
    state: ImportState,
    keyboard = new InlineKeyboard(),
  ): InlineKeyboard {
    const catalog = this.catalog(ctx);
    return keyboard.row()
      .text(catalog.importConfig.cancelButton, importCallback(state.receiptId, 'c'))
      .text(catalog.home.common.home, workflowReturnCallback(state.receiptId, 'home'));
  }

  private async complete(
    ctx: TelegramContext,
    state: ImportState,
    deliver: () => Promise<unknown>,
  ): Promise<void> {
    if (this.navigation) {
      await this.navigation.complete(ctx, { receipt: state.receipt }, {
        effectStage: 'pending',
        deliver: async () => { await deliver(); },
        failureNotice: this.catalog(ctx).home.recovery.unavailable,
      });
      return;
    }
    await deliver();
    await this.cancelExact({
      userId: state.userId,
      chatId: state.chatId,
      receiptId: state.receiptId,
    });
  }
}

function stateKey(userId: number, chatId: number): string {
  return `${userId}:${chatId}`;
}

function importCallback(receiptId: string, action: 'a' | 'c'): string {
  return `imp:${receiptId}:${action}`;
}

function parseImportCallback(data: string): { receiptId: string; action: 'a' | 'c' } | null {
  const match = IMPORT_CALLBACK.exec(data);
  return match ? { receiptId: match[1], action: match[2] as 'a' | 'c' } : null;
}

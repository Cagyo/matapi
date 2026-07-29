import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Composer, InlineKeyboard } from 'grammy';
import { randomBytes } from 'node:crypto';
import { BeginDriveConnectionUseCase, type PendingDriveConnection } from '../../archive/application/use-cases/begin-drive-connection.use-case';
import { SubmitDriveClientUseCase } from '../../archive/application/use-cases/submit-drive-client.use-case';
import { ConfirmDriveAccountUseCase } from '../../archive/application/use-cases/confirm-drive-account.use-case';
import { CancelDriveConnectionUseCase } from '../../archive/application/use-cases/cancel-drive-connection.use-case';
import { DisconnectDriveUseCase } from '../../archive/application/use-cases/disconnect-drive.use-case';
import {
  TELEGRAM_DRIVE_CLIENT_DOCUMENT_READER,
  type TelegramDriveClientDocumentAdapter,
} from '../infrastructure/telegram-drive-client-document.adapter';
import { GdriveStatusUseCase } from '../../camera/application/gdrive-status.use-case';
import { GdriveNotConfiguredError } from '../../camera/domain/errors/gdrive-not-configured.error';
import { GdriveNotInstalledError } from '../../camera/domain/errors/gdrive-not-installed.error';
import { GdriveStatusFailedError } from '../../camera/domain/errors/gdrive-status-failed.error';
import { en } from '../../locales/en';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';
import {
  WorkflowEntryCoordinator,
  type WorkflowLaunch,
} from './workflow-entry.coordinator';
import { WorkflowNavigationHandler } from './workflow-navigation.handler';

/**
 * `/gdrive status` — spec 15. Admin-only. Reports Drive quota, pending and
 * failed uploads, last upload time, and auto-cleanup configuration.
 */
@Injectable()
export class GdriveHandler implements TelegramHandler {
  private readonly logger = new Logger(GdriveHandler.name);
  private readonly pending = new Map<string, PendingDriveConnection>();
  private readonly disconnects = new Map<string, { receiptId: string; generationId: string; userId: number; chatId: number }>();

  constructor(
    private readonly status: GdriveStatusUseCase,
    private readonly guard: RoleMiddleware,
    private readonly workflows: WorkflowEntryCoordinator,
    @Optional() private readonly navigation?: WorkflowNavigationHandler,
    @Optional() @Inject(TELEGRAM_DRIVE_CLIENT_DOCUMENT_READER)
    private readonly documents?: Pick<TelegramDriveClientDocumentAdapter, 'read'>,
    @Optional() private readonly beginConnection?: BeginDriveConnectionUseCase,
    @Optional() private readonly submitClient?: SubmitDriveClientUseCase,
    @Optional() private readonly confirmAccount?: ConfirmDriveAccountUseCase,
    @Optional() private readonly cancelConnection?: CancelDriveConnectionUseCase,
    @Optional() private readonly disconnect?: DisconnectDriveUseCase,
  ) {}

  register(composer: Composer<TelegramContext>): void {
    composer.command('gdrive', this.guard.adminOnly, async (ctx) => {
      const sub = (ctx.match ?? '').toString().trim().toLowerCase();
      if (sub === 'connect') {
        await this.handleConnect(ctx);
        return;
      }
      if (sub === 'disconnect') {
        await this.handleDisconnect(ctx);
        return;
      }
      if (sub && sub !== 'status') {
        await ctx.reply((ctx.localeState?.catalog ?? en).gdrive.usage);
        return;
      }
      await this.handleStatus(ctx);
    });
    composer.on('message:document', async (ctx) => this.handleDocument(ctx));
    composer.callbackQuery(/^gdc:/, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => undefined);
      await this.handleCallback(ctx);
    });
  }

  async handleConnect(ctx: TelegramContext, launch?: WorkflowLaunch): Promise<void> {
    const current = this.currentAdmin(ctx);
    const catalog = ctx.localeState?.catalog ?? en;
    if (!current || !this.beginConnection) {
      if (ctx.chat?.type === 'private') await ctx.reply(catalog.common.adminRequired);
      return;
    }
    const pending = this.beginConnection.execute({ adminUserId: current.userId, chatId: current.chatId, receiptId: launch?.receipt.id });
    this.pending.set(bindingKey(current.userId, current.chatId), pending);
    await ctx.reply(catalog.gdriveConnection.uploadPrompt, {
      reply_markup: new InlineKeyboard().text(catalog.gdriveConnection.cancel, callback('c', pending.receiptId, pending.generationId)),
    });
  }

  /** Security gate intentionally precedes the first document read. */
  async handleDocument(ctx: TelegramContext): Promise<void> {
    const current = this.currentAdmin(ctx);
    if (!current || !ctx.message?.document) return;
    const catalog = ctx.localeState?.catalog ?? en;
    const pending = this.pending.get(bindingKey(current.userId, current.chatId));
    if (!pending || !this.documents || !this.submitClient) return;
    try {
      const document = await this.documents.read({
        fileId: ctx.message.document.file_id,
        fileSize: ctx.message.document.file_size,
      }, AbortSignal.timeout(30_000));
      const result = await this.submitClient.execute({ pending, document, signal: AbortSignal.timeout(30_000) });
      await this.deleteClientMessage(ctx, catalog.gdriveConnection.manualDelete);
      await ctx.reply(catalog.gdriveConnection.authorize(result.verificationUri, result.userCode), {
        reply_markup: new InlineKeyboard()
          .text(catalog.gdriveConnection.confirm, callback('a', pending.receiptId, pending.generationId))
          .text(catalog.gdriveConnection.cancel, callback('c', pending.receiptId, pending.generationId)),
      });
    } catch (error) {
      this.logger.warn(`Drive client document rejected: ${error instanceof Error ? error.name : 'unknown'}`);
      await ctx.reply(catalog.gdriveConnection.invalidClient);
    }
  }

  private async handleDisconnect(ctx: TelegramContext): Promise<void> {
    const current = this.currentAdmin(ctx);
    if (!current || !this.disconnect) return;
    const catalog = ctx.localeState?.catalog ?? en;
    const receiptId = randomReceipt();
    const generationId = await this.disconnect.activeGeneration();
    if (!generationId) { await ctx.reply(catalog.gdriveConnection.notConnected); return; }
    this.disconnects.set(receiptId, { receiptId, generationId, userId: current.userId, chatId: current.chatId });
    await ctx.reply(catalog.gdriveConnection.disconnectPrompt, {
      reply_markup: new InlineKeyboard()
        .text(catalog.gdriveConnection.disconnectConfirm, callback('d', receiptId, generationId))
        .text(catalog.gdriveConnection.cancel, callback('x', receiptId, generationId)),
    });
  }

  private async handleCallback(ctx: TelegramContext): Promise<void> {
    const current = this.currentAdmin(ctx);
    const parsed = parseCallback(ctx.callbackQuery?.data ?? '');
    if (!parsed) return;
    if (!current) {
      await this.cancelAfterRoleLoss(ctx, parsed);
      return;
    }
    const catalog = ctx.localeState?.catalog ?? en;
    if (parsed.action === 'd' || parsed.action === 'x') {
      const requested = this.disconnects.get(parsed.receiptId);
      if (!requested || requested.generationId !== parsed.generationId || requested.userId !== current.userId || requested.chatId !== current.chatId) return;
      this.disconnects.delete(parsed.receiptId);
      if (parsed.action === 'x') { await ctx.reply(catalog.gdriveConnection.cancelled); return; }
      if (!this.disconnect) return;
      const result = await this.disconnect.execute(requested.generationId, AbortSignal.timeout(5_000));
      await ctx.reply(result === 'disconnected' ? catalog.gdriveConnection.disconnected : catalog.gdriveConnection.notConnected);
      return;
    }
    const pending = this.pending.get(bindingKey(current.userId, current.chatId));
    if (!pending || pending.receiptId !== parsed.receiptId || pending.generationId !== parsed.generationId) return;
    if (parsed.action === 'c') {
      this.pending.delete(bindingKey(current.userId, current.chatId));
      const result = this.cancelConnection
        ? await this.cancelConnection.execute({ generationId: pending.generationId, receiptId: pending.receiptId, adminUserId: current.userId, chatId: current.chatId })
        : 'stale';
      if (result === 'cancelled') await ctx.reply(catalog.gdriveConnection.cancelled);
      return;
    }
    if (parsed.action !== 'a' || !this.confirmAccount) return;
    try {
      const result = await this.confirmAccount.execute({ generationId: pending.generationId, receiptId: pending.receiptId, adminUserId: current.userId, chatId: current.chatId, signal: AbortSignal.timeout(30_000) });
      if (result === 'activated') {
        this.pending.delete(bindingKey(current.userId, current.chatId));
        await ctx.reply(catalog.gdriveConnection.connected);
      }
    } catch {
      this.pending.delete(bindingKey(current.userId, current.chatId));
      await ctx.reply(catalog.gdriveConnection.connectionFailed);
    }
  }

  private currentAdmin(ctx: TelegramContext): { userId: number; chatId: number } | null {
    if (ctx.chat?.type !== 'private' || ctx.localeState?.user.role !== 'admin' || !ctx.from) return null;
    return { userId: ctx.from.id, chatId: ctx.chat.id };
  }

  private async cancelAfterRoleLoss(ctx: TelegramContext, parsed: { receiptId: string; generationId: string }): Promise<void> {
    if (ctx.chat?.type !== 'private' || !ctx.from) return;
    const pending = this.pending.get(bindingKey(ctx.from.id, ctx.chat.id));
    if (!pending || pending.receiptId !== parsed.receiptId || pending.generationId !== parsed.generationId) return;
    this.pending.delete(bindingKey(ctx.from.id, ctx.chat.id));
    this.documents && this.cancelConnection && await this.cancelConnection.execute({
      generationId: pending.generationId,
      receiptId: pending.receiptId,
      adminUserId: ctx.from.id,
      chatId: ctx.chat.id,
    });
  }

  private async deleteClientMessage(ctx: TelegramContext, warning: string): Promise<void> {
    const messageId = ctx.message?.message_id;
    const chatId = ctx.chat?.id;
    if (!messageId || !chatId) return;
    try { await ctx.api.deleteMessage(chatId, messageId); }
    catch { await ctx.reply(warning); }
  }

  async handleStatus(
    ctx: TelegramContext,
    _options: { includeCleanupAction?: boolean } = {},
    launch?: WorkflowLaunch,
  ): Promise<void> {
    const receipt = launch?.receipt ?? await this.workflows.begin(ctx, 'drive-status', {
      source: 'natural-parent',
    });
    if (!receipt) return;
    const catalog = ctx.localeState?.catalog ?? en;
    try {
      const result = await this.status.execute();
      const body = catalog.gdrive.body({
        usedBytes: result.quota.usedBytes,
        totalBytes: result.quota.totalBytes,
        lastUploadAt: result.lastUploadAt,
        pendingUploads: result.pendingUploads,
        failedUploads: result.failedUploads,
        lastError: result.lastError,
        cleanupMinAgeDays: result.cleanupMinAgeDays,
      });
      await this.complete(ctx, receipt, () => ctx.reply(`${catalog.gdrive.header}\n\n${body}`));
    } catch (err) {
      await this.handleError(ctx, receipt, err);
    }
  }

  private async handleError(
    ctx: TelegramContext,
    receipt: WorkflowLaunch['receipt'],
    err: unknown,
  ): Promise<void> {
    const catalog = ctx.localeState?.catalog ?? en;
    if (err instanceof GdriveNotInstalledError) {
      await this.complete(ctx, receipt, () => ctx.reply(catalog.gdrive.notInstalled));
      return;
    }
    if (err instanceof GdriveNotConfiguredError) {
      await this.complete(ctx, receipt, () => ctx.reply(catalog.gdrive.notConfigured));
      return;
    }
    if (err instanceof GdriveStatusFailedError) {
      await this.complete(ctx, receipt, () => ctx.reply(catalog.gdrive.statusFailed(err.reason)));
      return;
    }
    this.logger.error(
      `/gdrive status failed: ${(err as Error).message}`,
      (err as Error).stack,
    );
    await this.complete(ctx, receipt, () => ctx.reply(catalog.common.error('/gdrive status', (err as Error).message)));
  }

  private async complete(
    ctx: TelegramContext,
    receipt: WorkflowLaunch['receipt'],
    deliver: () => Promise<unknown>,
  ): Promise<void> {
    const catalog = ctx.localeState?.catalog ?? en;
    if (this.navigation) {
      await this.navigation.complete(ctx, { receipt }, {
        effectStage: 'pending',
        deliver: async () => { await deliver(); },
        failureNotice: catalog.home.recovery.unavailable,
      });
      return;
    }
    await deliver();
  }
}

type DriveCallbackAction = 'a' | 'c' | 'd' | 'x';

function callback(action: DriveCallbackAction, receiptId: string, generationId: string): string {
  return `gdc:${receiptId}:${generationId}:${action}`;
}

function parseCallback(data: string): { receiptId: string; generationId: string; action: DriveCallbackAction } | null {
  const match = /^gdc:([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{1,16}):(a|c|d|x)$/.exec(data);
  return match ? { receiptId: match[1], generationId: match[2], action: match[3] as DriveCallbackAction } : null;
}

function bindingKey(userId: number, chatId: number): string {
  return `${userId}:${chatId}`;
}

function randomReceipt(): string {
  return randomBytes(12).toString('base64url');
}

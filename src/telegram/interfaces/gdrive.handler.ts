import { Inject, Injectable, Logger } from '@nestjs/common';
import { Composer, InlineKeyboard } from 'grammy';
import { randomBytes } from 'node:crypto';
import { BeginDriveConnectionUseCase, type PendingDriveConnection } from '../../archive/application/use-cases/begin-drive-connection.use-case';
import {
  SubmitDriveClientUseCase,
  type DriveClientSubmissionResult,
} from '../../archive/application/use-cases/submit-drive-client.use-case';
import { ConfirmDriveAccountUseCase } from '../../archive/application/use-cases/confirm-drive-account.use-case';
import { CancelDriveConnectionUseCase } from '../../archive/application/use-cases/cancel-drive-connection.use-case';
import { DisconnectDriveUseCase } from '../../archive/application/use-cases/disconnect-drive.use-case';
import { DriveClientDocumentError } from '../../archive/domain/errors/drive-client-document.error';
import { DriveOAuthClientRejectedError } from '../../archive/domain/errors/drive-oauth-client-rejected.error';
import { DrivePolicyBlockedError } from '../../archive/domain/errors/drive-policy-blocked.error';
import { DriveProviderResponseError } from '../../archive/domain/errors/drive-provider-response.error';
import { DriveRateLimitedError } from '../../archive/domain/errors/drive-rate-limited.error';
import { DriveSetupBusyError } from '../../archive/domain/errors/drive-setup-busy.error';
import { DriveSetupExpiredError } from '../../archive/domain/errors/drive-setup-expired.error';
import { DriveTemporaryUnavailableError } from '../../archive/domain/errors/drive-temporary-unavailable.error';
import {
  TELEGRAM_DRIVE_CLIENT_DOCUMENT_READER,
  type TelegramDriveClientDocument,
  type TelegramDriveClientDocumentAdapter,
} from '../infrastructure/telegram-drive-client-document.adapter';
import { ReportDriveStatusUseCase } from '../../archive/application/use-cases/report-drive-status.use-case';
import {
  RetryDriveArchiveUseCase,
  type RetryDriveArchiveResult,
} from '../../archive/application/use-cases/retry-drive-archive.use-case';
import { en } from '../../locales/en';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';
import {
  WorkflowEntryCoordinator,
  type WorkflowLaunch,
} from './workflow-entry.coordinator';
import { WorkflowNavigationHandler } from './workflow-navigation.handler';
import { workflowReturnCallback } from '../domain/workflow-return';
import {
  DriveSetupStateRegistry,
  type DriveSetupGenerationIdentity,
  type DriveSetupIdentity,
  type DriveSetupState,
} from './drive-setup-state.registry';

const GOOGLE_CLOUD_CONSOLE_URL = 'https://console.cloud.google.com/apis/credentials';

/**
 * `/gdrive status` — private-admin only. Reports the sanitized archive state.
 */
@Injectable()
export class GdriveHandler implements TelegramHandler {
  private readonly logger = new Logger(GdriveHandler.name);
  private readonly disconnects = new Map<string, { receiptId: string; generationId: string; userId: number; chatId: number }>();
  private readonly retries = new Map<string, ArchiveRetryReceipt>();

  constructor(
    private readonly status: ReportDriveStatusUseCase,
    private readonly guard: RoleMiddleware,
    private readonly workflows: WorkflowEntryCoordinator,
    @Inject(WorkflowNavigationHandler) private readonly navigation: WorkflowNavigationHandler | undefined,
    @Inject(TELEGRAM_DRIVE_CLIENT_DOCUMENT_READER)
    private readonly documents: Pick<TelegramDriveClientDocumentAdapter, 'read'>,
    private readonly beginConnection: BeginDriveConnectionUseCase,
    private readonly submitClient: SubmitDriveClientUseCase,
    private readonly confirmAccount: ConfirmDriveAccountUseCase,
    private readonly cancelConnection: CancelDriveConnectionUseCase,
    private readonly disconnect: DisconnectDriveUseCase,
    @Inject(DriveSetupStateRegistry) private readonly setupStates: DriveSetupStateRegistry,
    @Inject(RetryDriveArchiveUseCase) private readonly retry: RetryDriveArchiveUseCase,
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
      if (sub === 'retry') {
        await this.handleRetry(ctx);
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
    composer.callbackQuery(/^gdr:/, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => undefined);
      await this.handleRetryCallback(ctx);
    });
  }

  async handleConnect(ctx: TelegramContext, launch?: WorkflowLaunch): Promise<void> {
    const current = this.currentAdmin(ctx);
    const catalog = ctx.localeState?.catalog ?? en;
    if (!current) {
      if (ctx.chat?.type === 'private') await ctx.reply(catalog.common.adminRequired);
      return;
    }
    const receipt = launch?.receipt ?? await this.workflows.begin(ctx, 'drive-setup', {
      source: 'natural-parent',
    });
    if (!receipt) return;
    const identity = {
      userId: current.userId,
      chatId: current.chatId,
      receiptId: receipt.id,
    };
    this.setupStates.prepare({
      ...identity,
      preparationExpiresAtMs: receipt.expiresAt.getTime(),
    });
    try {
      await ctx.reply(catalog.gdriveConnection.guide, {
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard()
          .url(catalog.gdriveConnection.openConsole, GOOGLE_CLOUD_CONSOLE_URL)
          .text(catalog.gdriveConnection.cancel, workflowReturnCallback(receipt.id, 'origin')),
      });
    } catch (error) {
      this.setupStates.removePreparation(identity);
      throw error;
    }
  }

  /** Security gate intentionally precedes the first document read. */
  async handleDocument(ctx: TelegramContext): Promise<void> {
    const raw = rawPrivateIdentity(ctx);
    const associated = raw ? this.setupStates.association(raw) : null;
    if (!associated) return;
    const catalog = ctx.localeState?.catalog ?? en;
    let generation: DriveSetupGenerationIdentity | null = null;
    let claimed = false;
    let submitted = false;
    try {
      if (!ctx.message?.document) return;
      const admin = this.currentAdmin(ctx);
      if (!admin || !await this.workflows.loadCurrent(ctx, associated.receiptId, 'drive-setup')) {
        await this.setupStates.cancelExact(associated);
        return;
      }
      if (ctx.message.forward_origin) {
        await ctx.reply(catalog.gdriveConnection.documentInvalid);
        return;
      }
      const pending = this.beginConnection.execute({
        adminUserId: admin.userId,
        chatId: admin.chatId,
        receiptId: associated.receiptId,
      });
      generation = {
        userId: admin.userId,
        chatId: admin.chatId,
        receiptId: associated.receiptId,
        generationId: pending.generationId,
      };
      const authorizing = this.setupStates.claimAuthorizing(associated, pending);
      if (!authorizing) return;
      claimed = true;
      const operationSignal = AbortSignal.any([
        authorizing.controller.signal,
        AbortSignal.timeout(30_000),
      ]);
      const document = await this.documents.read(documentInput(ctx), operationSignal);
      const result = await this.submitClient.execute({
        pending,
        document,
        signal: operationSignal,
        authorizationSignal: authorizing.controller.signal,
        acceptChallenge: (binding) => this.setupStates.recordChallenge({ ...associated, ...binding }),
      });
      submitted = true;
      await this.replyWithAuthorization(ctx, result, pending);
    } catch (error) {
      await this.handleSetupError(ctx, associated, generation, claimed, submitted, error);
    } finally {
      await this.deleteAssociatedDocument(ctx, catalog.gdriveConnection.manualDelete);
    }
  }

  private async replyWithAuthorization(
    ctx: TelegramContext,
    result: DriveClientSubmissionResult,
    pending: PendingDriveConnection,
  ): Promise<void> {
    const catalog = ctx.localeState?.catalog ?? en;
    await ctx.reply(catalog.gdriveConnection.authorize(result.verificationUri, result.userCode), {
      reply_markup: new InlineKeyboard()
        .text(catalog.gdriveConnection.confirm, callback('a', pending.receiptId, pending.generationId))
        .text(catalog.gdriveConnection.cancel, callback('c', pending.receiptId, pending.generationId)),
    });
  }

  private async handleSetupError(
    ctx: TelegramContext,
    preparation: DriveSetupIdentity,
    generation: DriveSetupGenerationIdentity | null,
    claimed: boolean,
    submitted: boolean,
    error: unknown,
  ): Promise<void> {
    const catalog = ctx.localeState?.catalog ?? en;
    if (error instanceof DriveSetupExpiredError) {
      if (!await this.terminalizeExpiredSetup(preparation, generation, claimed)) return;
      await this.completeSetup(ctx, preparation.receiptId, catalog.gdriveConnection.setupExpired);
      return;
    }
    if (generation) {
      if (submitted) {
        await this.cancelConnection.execute({
          generationId: generation.generationId,
          receiptId: generation.receiptId,
          adminUserId: generation.userId,
          chatId: generation.chatId,
        });
      }
      if (!this.setupStates.returnToPreparing(generation)) return;
    } else {
      const current = this.setupStates.association(preparation);
      if (current?.receiptId !== preparation.receiptId) return;
    }
    const reply = error instanceof DriveClientDocumentError
      ? error.reason === 'unsupported-client-type'
        ? catalog.gdriveConnection.unsupportedClientType
        : catalog.gdriveConnection.documentInvalid
      : error instanceof DriveOAuthClientRejectedError ? catalog.gdriveConnection.clientRejected
        : error instanceof DriveSetupBusyError ? catalog.gdriveConnection.setupBusy
          : error instanceof DrivePolicyBlockedError ? catalog.gdriveConnection.policyBlocked
            : error instanceof DriveRateLimitedError ? catalog.gdriveConnection.rateLimited
              : error instanceof DriveProviderResponseError ? catalog.gdriveConnection.providerResponse
                : catalog.gdriveConnection.temporaryUnavailable;
    if (!(error instanceof DriveClientDocumentError
      || error instanceof DriveOAuthClientRejectedError
      || error instanceof DriveSetupBusyError
      || error instanceof DrivePolicyBlockedError
      || error instanceof DriveRateLimitedError
      || error instanceof DriveProviderResponseError
      || error instanceof DriveTemporaryUnavailableError)) {
      this.logger.error('Unexpected Drive setup failure');
    }
    await ctx.reply(reply);
  }

  private async terminalizeExpiredSetup(
    preparation: DriveSetupIdentity,
    generation: DriveSetupGenerationIdentity | null,
    claimed: boolean,
  ): Promise<boolean> {
    if (claimed && generation) return this.setupStates.takeTerminal(generation) !== null;
    return await this.setupStates.cancelExact(preparation) === 'cancelled';
  }

  private async deleteAssociatedDocument(ctx: TelegramContext, warning: string): Promise<void> {
    const messageId = ctx.message?.message_id;
    const chatId = ctx.chat?.id;
    if (!messageId || !chatId) return;
    try {
      await ctx.api.deleteMessage(chatId, messageId);
    } catch {
      try {
        await ctx.reply(warning);
      } catch {
        this.logger.warn('Drive credential message deletion warning delivery failed');
      }
    }
  }

  private async handleDisconnect(ctx: TelegramContext): Promise<void> {
    const current = this.currentAdmin(ctx);
    if (!current) return;
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
    if (!current) return;
    const catalog = ctx.localeState?.catalog ?? en;
    if (parsed.action === 'd' || parsed.action === 'x') {
      const requested = this.disconnects.get(parsed.receiptId);
      if (requested?.generationId !== parsed.generationId || requested.userId !== current.userId || requested.chatId !== current.chatId) return;
      this.disconnects.delete(parsed.receiptId);
      if (parsed.action === 'x') { await ctx.reply(catalog.gdriveConnection.cancelled); return; }
      const result = await this.disconnect.execute(requested.generationId, AbortSignal.timeout(5_000));
      await ctx.reply(result === 'disconnected' ? catalog.gdriveConnection.disconnected : catalog.gdriveConnection.notConnected);
      return;
    }
    const state = this.setupStates.authorizing({
      userId: current.userId,
      chatId: current.chatId,
      receiptId: parsed.receiptId,
      generationId: parsed.generationId,
    });
    if (!state) return;
    if (parsed.action === 'c') {
      if (!await this.workflows.loadCurrent(ctx, state.receiptId, 'drive-setup')) return;
      const result = await this.setupStates.cancelExact(state);
      if (result === 'cancelled') {
        await this.completeSetup(ctx, state.receiptId, catalog.gdriveConnection.cancelled);
      }
      return;
    }
    if (parsed.action !== 'a') return;
    if (!state.effectiveDeadlineMs
      || !await this.workflows.loadCurrent(ctx, state.receiptId, 'drive-setup')) return;
    const signal = AbortSignal.any([state.controller.signal, AbortSignal.timeout(30_000)]);
    try {
      const result = await this.confirmAccount.execute({
        generationId: state.pending.generationId,
        receiptId: state.receiptId,
        adminUserId: state.userId,
        chatId: state.chatId,
        effectiveDeadlineMs: state.effectiveDeadlineMs,
        signal,
      });
      if (result === 'pending') {
        if (!await this.workflows.loadCurrent(ctx, state.receiptId, 'drive-setup')) return;
        if (!this.setupStates.authorizing({
          userId: state.userId,
          chatId: state.chatId,
          receiptId: state.receiptId,
          generationId: state.pending.generationId,
        })) return;
        await ctx.reply(catalog.gdriveConnection.authorizationPending);
        return;
      }
      if (result !== 'activated' || !this.setupStates.takeActivated({
        userId: state.userId,
        chatId: state.chatId,
        receiptId: state.receiptId,
        generationId: state.pending.generationId,
      })) return;
      const receipt = await this.workflows.loadCurrent(ctx, state.receiptId, 'drive-setup');
      if (!receipt) return;
      await this.navigation?.complete(ctx, { receipt }, {
        effectStage: 'pending',
        deliver: async () => { await ctx.reply(catalog.gdriveConnection.connected); },
        failureNotice: catalog.home.recovery.unavailable,
      });
    } catch (error) {
      await this.handleConfirmationError(ctx, state, error);
    }
  }

  private async handleConfirmationError(
    ctx: TelegramContext,
    state: Extract<DriveSetupState, { kind: 'authorizing' }>,
    error: unknown,
  ): Promise<void> {
    const identity = {
      userId: state.userId,
      chatId: state.chatId,
      receiptId: state.receiptId,
      generationId: state.pending.generationId,
    };
    if (!this.setupStates.takeTerminal(identity)) return;
    const catalog = ctx.localeState?.catalog ?? en;
    const message = error instanceof DriveSetupExpiredError ? catalog.gdriveConnection.setupExpired
      : error instanceof DrivePolicyBlockedError ? catalog.gdriveConnection.policyBlocked
        : error instanceof DriveRateLimitedError ? catalog.gdriveConnection.rateLimited
          : error instanceof DriveProviderResponseError ? catalog.gdriveConnection.providerResponse
            : catalog.gdriveConnection.temporaryUnavailable;
    await this.completeSetup(ctx, state.receiptId, message);
  }

  private async completeSetup(ctx: TelegramContext, receiptId: string, message: string): Promise<void> {
    const receipt = await this.workflows.loadCurrent(ctx, receiptId, 'drive-setup');
    if (!receipt) return;
    if (!this.navigation) {
      await ctx.reply(message);
      return;
    }
    await this.navigation.complete(ctx, { receipt }, {
      effectStage: 'pending',
      deliver: async () => { await ctx.reply(message); },
      failureNotice: (ctx.localeState?.catalog ?? en).home.recovery.unavailable,
    });
  }

  private currentAdmin(ctx: TelegramContext): { userId: number; chatId: number } | null {
    if (ctx.chat?.type !== 'private' || ctx.localeState?.user.role !== 'admin' || !ctx.from) return null;
    return { userId: ctx.from.id, chatId: ctx.chat.id };
  }

  async handleStatus(
    ctx: TelegramContext,
    _options: { includeCleanupAction?: boolean } = {},
    launch?: WorkflowLaunch,
  ): Promise<void> {
    // This method is also reached from Home, so retain the private-admin gate
    // even when command middleware is bypassed in a direct call.
    if (!this.currentAdmin(ctx)) return;
    const receipt = launch?.receipt ?? await this.workflows.begin(ctx, 'drive-status', {
      source: 'natural-parent',
    });
    if (!receipt) return;
    const catalog = ctx.localeState?.catalog ?? en;
    let retryReceipt: string | null = null;
    try {
      const result = await this.status.execute();
      const body = catalog.gdrive.body(result);
      const replyMarkup = result.recovery?.retryable
        ? this.storeRetryReceipt(ctx, result.recovery)
        : undefined;
      retryReceipt = replyMarkup?.receipt ?? null;
      await this.complete(ctx, receipt, () => ctx.reply(`${catalog.gdrive.header}\n\n${body}`, replyMarkup?.options));
    } catch (err) {
      if (retryReceipt) this.retries.delete(retryReceipt);
      await this.handleError(ctx, receipt, err);
    }
  }

  /** Private-admin-only retry entry that accepts no Drive identifier from Telegram. */
  async handleRetry(ctx: TelegramContext): Promise<void> {
    if (!this.currentAdmin(ctx)) return;
    const catalog = ctx.localeState?.catalog ?? en;
    try {
      const report = await this.status.execute();
      await ctx.reply(catalog.gdrive.retryResults[await this.retryFromReport(report)]);
    } catch {
      this.logger.error('/gdrive retry failed');
      await ctx.reply(catalog.gdrive.retryResults.stale);
    }
  }

  private async handleRetryCallback(ctx: TelegramContext): Promise<void> {
    const current = this.currentAdmin(ctx);
    const receiptId = parseRetryCallback(ctx.callbackQuery?.data ?? '');
    if (!current || !receiptId) return;
    const requested = this.retries.get(receiptId);
    if (requested?.userId !== current.userId || requested?.chatId !== current.chatId) return;
    this.retries.delete(receiptId);
    const catalog = ctx.localeState?.catalog ?? en;
    try {
      const result = await this.retry.execute({
        generationId: requested.generationId,
        observedProviderRevision: requested.providerRevision,
      });
      await ctx.reply(catalog.gdrive.retryResults[result]);
    } catch {
      this.logger.error('/gdrive retry callback failed');
      await ctx.reply(catalog.gdrive.retryResults.stale);
    }
  }

  private async retryFromReport(report: Awaited<ReturnType<ReportDriveStatusUseCase['execute']>>): Promise<RetryDriveArchiveResult> {
    if (report.recovery?.retryable) {
      return this.retry.execute({
        generationId: report.recovery.generationId,
        observedProviderRevision: report.recovery.providerRevision,
      });
    }
    if (report.requiredAction === 'free-drive-space') return 'automatic-quota-probe';
    if (report.requiredAction === 'reauthorize') return 'reauthorize';
    return 'nothing-blocked';
  }

  private storeRetryReceipt(
    ctx: TelegramContext,
    recovery: NonNullable<Awaited<ReturnType<ReportDriveStatusUseCase['execute']>>['recovery']>,
  ): { receipt: string; options: { reply_markup: InlineKeyboard } } | undefined {
    const current = this.currentAdmin(ctx);
    if (!current || !recovery.retryable) return undefined;
    const receipt = randomReceipt();
    this.retries.set(receipt, {
      userId: current.userId,
      chatId: current.chatId,
      generationId: recovery.generationId,
      providerRevision: recovery.providerRevision,
    });
    return {
      receipt,
      options: {
        reply_markup: new InlineKeyboard().text((ctx.localeState?.catalog ?? en).gdrive.retryButton, `gdr:${receipt}`),
      },
    };
  }

  private async handleError(
    ctx: TelegramContext,
    receipt: WorkflowLaunch['receipt'],
    _err: unknown,
  ): Promise<void> {
    const catalog = ctx.localeState?.catalog ?? en;
    // Provider errors can contain credentials or private Drive URLs. Neither
    // replies nor logs include the raw error value.
    this.logger.error('/gdrive status failed');
    await this.complete(ctx, receipt, () => ctx.reply(catalog.gdrive.statusUnavailable));
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

interface ArchiveRetryReceipt {
  userId: number;
  chatId: number;
  generationId: string;
  providerRevision: number;
}

type DriveCallbackAction = 'a' | 'c' | 'd' | 'x';

function callback(action: DriveCallbackAction, receiptId: string, generationId: string): string {
  return `gdc:${receiptId}:${generationId}:${action}`;
}

function parseCallback(data: string): { receiptId: string; generationId: string; action: DriveCallbackAction } | null {
  const match = /^gdc:([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{1,16}):(a|c|d|x)$/.exec(data);
  return match ? { receiptId: match[1], generationId: match[2], action: match[3] as DriveCallbackAction } : null;
}

function parseRetryCallback(data: string): string | null {
  const match = /^gdr:([A-Za-z0-9_-]{16})$/.exec(data);
  return match?.[1] ?? null;
}

function randomReceipt(): string {
  return randomBytes(12).toString('base64url');
}

function rawPrivateIdentity(ctx: TelegramContext): { userId: number; chatId: number } | null {
  return ctx.chat?.type === 'private' && ctx.from
    ? { userId: ctx.from.id, chatId: ctx.chat.id }
    : null;
}

function documentInput(ctx: TelegramContext): TelegramDriveClientDocument {
  const document = ctx.message?.document;
  if (!document) throw new DriveClientDocumentError('invalid-credentials');
  return { fileId: document.file_id, fileSize: document.file_size };
}

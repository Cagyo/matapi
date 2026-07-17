import { createHash } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Composer, InlineKeyboard, InputFile } from 'grammy';
import { catalogFor } from '../../locales';
import { en, TYPE_ICONS } from '../../locales/en';
import { ListSensorHistoryTargetsUseCase } from '../../sensors/application/list-sensor-history-targets.use-case';
import { MalformedSensorLogTimestampError } from '../../sensors/domain/errors/malformed-sensor-log-timestamp.error';
import { SensorLogHistoryEmptyError } from '../../sensors/domain/errors/sensor-log-history-empty.error';
import { SensorLogExportRowTooLargeError } from '../../sensors/domain/errors/sensor-log-export-row-too-large.error';
import { SensorNotFoundError } from '../../sensors/domain/errors/sensor-not-found.error';
import type { SensorHistoryPage, SensorHistoryTarget } from '../../sensors/domain/ports/sensor-query.port';
import { StageCsvExportUseCase } from '../application/stage-csv-export.use-case';
import { CsvDocumentTooLargeError, type CsvTempFile } from '../application/ports/csv-temp-file.port';
import type { WorkflowReturnReceipt } from '../domain/workflow-return';
import { workflowReturnCallback } from '../domain/workflow-return';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';
import { WorkflowEntryCoordinator, type WorkflowLaunch } from './workflow-entry.coordinator';
import { WorkflowNavigationHandler } from './workflow-navigation.handler';

const DEFAULT_CSV_COUNT = 1000;
const MAX_CSV_COUNT = 5000;
const PAGE_SIZE = 20;
const SELECTOR_LENGTH = 12;
const MAX_CALLBACK_BYTES = 64;
const CSV_CALLBACK = /^csv:([A-Za-z0-9_-]{16}):(p|s):(.+)$/;

type PickerCallback =
  | { receiptId: string; kind: 'page'; page: number }
  | {
      receiptId: string;
      kind: 'select';
      page: number;
      index: number;
      selector: string;
    };

/** Parse `/csv <sensor> [count]` while preserving the fixed 1–5000 limit. */
export function parseCsvArgs(raw: string): { name: string; count: number } | null {
  const [name, countToken, ...rest] = raw.trim().split(/\s+/).filter(Boolean);
  if (!name || rest.length > 0) return null;
  if (!countToken) return { name, count: DEFAULT_CSV_COUNT };
  if (!/^\d+$/.test(countToken)) return null;
  const count = Number(countToken);
  return Number.isSafeInteger(count) && count >= 1 && count <= MAX_CSV_COUNT ? { name, count } : null;
}

@Injectable()
export class CsvHandler implements TelegramHandler {
  private readonly logger = new Logger(CsvHandler.name);
  private readonly activeUploads = new Set<string>();
  private readonly pickers = new Map<string, WorkflowReturnReceipt>();

  constructor(
    private readonly historyTargets: ListSensorHistoryTargetsUseCase,
    private readonly stage: StageCsvExportUseCase,
    private readonly guard: RoleMiddleware,
    private readonly workflows: WorkflowEntryCoordinator,
    @Optional() private readonly navigation?: WorkflowNavigationHandler,
  ) {}

  // The string form is a one-release call-site compatibility shim for the
  // legacy menu. It deliberately does not change receipt origin semantics.
  async handleEmpty(ctx: TelegramContext, launch?: WorkflowLaunch | 'menu', page = 0): Promise<void> {
    const receipt =
      (typeof launch === 'object' ? launch.receipt : undefined) ??
      (await this.workflows.begin(ctx, 'csv', {
        source: 'natural-parent',
      }));
    if (!receipt) return;
    this.pickers.set(pickerKey(ctx, receipt.id), receipt);
    try {
      const historyPage = await this.loadPage(page);
      await this.replyPicker(ctx, receipt, historyPage);
    } catch (error) {
      this.logFailure('CSV target picker', error);
      await this.complete(ctx, receipt, () => ctx.reply(en.csv.failed));
    }
  }

  register(composer: Composer<TelegramContext>): void {
    composer.command('csv', this.guard.registered, async (ctx) => this.handleCommand(ctx));
    composer.command('export_csv', this.guard.registered, async (ctx) => this.handleCommand(ctx));
    composer.callbackQuery(CSV_CALLBACK, this.guard.registered, async (ctx) => this.handleCallback(ctx));
  }

  private async handleCommand(ctx: TelegramContext): Promise<void> {
    const receipt = await this.workflows.begin(ctx, 'csv', {
      source: 'natural-parent',
    });
    if (!receipt) return;
    const raw = (ctx.match ?? '').toString();
    if (!raw.trim()) {
      await this.handleEmpty(ctx, { receipt });
      return;
    }
    const args = parseCsvArgs(raw);
    if (!args) {
      await this.complete(ctx, receipt, () => ctx.reply(en.csv.invalidCount));
      return;
    }
    await this.startExport(ctx, receipt, { kind: 'name', name: args.name }, args.count);
  }

  private async handleCallback(ctx: TelegramContext): Promise<void> {
    await ctx.answerCallbackQuery().catch(() => undefined);
    const callback = parsePickerCallback(ctx.callbackQuery?.data ?? '');
    if (!callback) return;
    const receipt = this.pickers.get(pickerKey(ctx, callback.receiptId));
    if (receipt?.id !== callback.receiptId) return;
    if (!(await this.workflows.validateCurrent(ctx, receipt))) return;
    if (callback.kind === 'page') {
      await this.handlePage(ctx, receipt, callback.page);
      return;
    }
    await this.handleSelection(ctx, receipt, callback);
  }

  private async handlePage(ctx: TelegramContext, receipt: WorkflowReturnReceipt, page: number): Promise<void> {
    try {
      const historyPage = await this.loadPage(page);
      await this.editPicker(ctx, receipt, historyPage);
    } catch (error) {
      this.logFailure('CSV picker page', error);
      await this.complete(ctx, receipt, () => ctx.reply(en.csv.failed));
    }
  }

  private async handleSelection(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    callback: Extract<PickerCallback, { kind: 'select' }>,
  ): Promise<void> {
    const lockKey = uploadKey(ctx, receipt.id);
    if (!lockKey || this.activeUploads.has(lockKey)) return;
    this.activeUploads.add(lockKey);
    let detached = false;
    try {
      const page = await this.loadPage(callback.page);
      const target = page.targets[callback.index];
      if (page.page !== callback.page || !target || selectorFor(target.id) !== callback.selector) {
        await this.complete(ctx, receipt, () => ctx.reply(en.csv.invalidSelection));
        return;
      }
      if (!(await this.workflows.markRunning(ctx, receipt))) return;
      this.pickers.delete(pickerKey(ctx, receipt.id));
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      await this.replyStaging(ctx, receipt);
      this.detachExport(ctx, receipt, { kind: 'id', id: target.id }, DEFAULT_CSV_COUNT, lockKey);
      detached = true;
    } catch (error) {
      this.logFailure('CSV selection', error);
      await this.complete(ctx, receipt, () => ctx.reply(this.errorCopy(error)));
    } finally {
      if (!detached) this.activeUploads.delete(lockKey);
    }
  }

  private async startExport(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    target: { readonly kind: 'name'; readonly name: string } | { readonly kind: 'id'; readonly id: string },
    count: number,
  ): Promise<void> {
    if (!(await this.workflows.markRunning(ctx, receipt))) return;
    await this.replyStaging(ctx, receipt);
    this.detachExport(ctx, receipt, target, count);
  }

  private detachExport(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    target: { readonly kind: 'name'; readonly name: string } | { readonly kind: 'id'; readonly id: string },
    count: number,
    lockKey?: string,
  ): void {
    void this.runDetachedExport(ctx, receipt, target, count, lockKey);
  }

  private async runDetachedExport(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    target: { readonly kind: 'name'; readonly name: string } | { readonly kind: 'id'; readonly id: string },
    count: number,
    lockKey?: string,
  ): Promise<void> {
    try {
      await this.stageAndUpload(ctx, receipt, target, count);
    } catch (error) {
      this.logFailure('Detached CSV export', error);
    } finally {
      if (lockKey) this.activeUploads.delete(lockKey);
    }
  }

  private async stageAndUpload(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    target: { readonly kind: 'name'; readonly name: string } | { readonly kind: 'id'; readonly id: string },
    count: number,
  ): Promise<void> {
    let file: CsvTempFile | undefined;
    try {
      await ctx.replyWithChatAction('upload_document');
      file = await this.stage.execute({ target, limit: count });
      const staged = file;
      await this.complete(ctx, receipt, () =>
        ctx.replyWithDocument(new InputFile(() => staged.open(), staged.filename), { caption: en.csv.caption }),
      );
    } catch (error) {
      const copy = this.errorCopy(error);
      if (copy === en.csv.failed) this.logFailure('CSV export', error);
      await this.complete(ctx, receipt, () => ctx.reply(copy));
    } finally {
      if (file) {
        try {
          await file.dispose();
        } catch (error) {
          this.logFailure('CSV temporary-file disposal', error);
        }
      }
    }
  }

  private async replyPicker(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    page: SensorHistoryPage,
  ): Promise<void> {
    const keyboard = this.createPicker(ctx, receipt, page);
    if (!keyboard) {
      await this.complete(ctx, receipt, () => ctx.reply(en.csv.empty));
      return;
    }
    await ctx.reply(en.csv.selectTarget, { reply_markup: keyboard });
  }

  private async editPicker(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    page: SensorHistoryPage,
  ): Promise<void> {
    const keyboard = this.createPicker(ctx, receipt, page);
    if (!keyboard) {
      await this.complete(ctx, receipt, () => ctx.editMessageText(en.csv.empty));
      return;
    }
    await ctx.editMessageText(en.csv.selectTarget, { reply_markup: keyboard });
  }

  private createPicker(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    page: SensorHistoryPage,
  ): InlineKeyboard | null {
    if (page.pageCount === 0) return null;
    const keyboard = new InlineKeyboard();
    page.targets.forEach((target, index) =>
      keyboard.text(targetLabel(target), selectionData(receipt.id, page.page, index, target.id)).row(),
    );
    if (page.page > 0) keyboard.text(en.csv.previousPage, pageData(receipt.id, page.page - 1));
    if (page.page + 1 < page.pageCount) keyboard.text(en.csv.nextPage, pageData(receipt.id, page.page + 1));
    keyboard.row().text(this.catalog(ctx).home.common.home, workflowReturnCallback(receipt.id, 'origin'));
    return keyboard;
  }

  private async replyStaging(ctx: TelegramContext, receipt: WorkflowReturnReceipt): Promise<void> {
    await ctx.reply(this.catalog(ctx).csv.staging, {
      reply_markup: new InlineKeyboard().text(
        this.catalog(ctx).home.common.home,
        workflowReturnCallback(receipt.id, 'origin'),
      ),
    });
  }

  private async complete(
    ctx: TelegramContext,
    receipt: WorkflowReturnReceipt,
    deliver: () => Promise<unknown>,
  ): Promise<void> {
    if (this.navigation) {
      await this.navigation.complete(
        ctx,
        { receipt },
        {
          effectStage: 'pending',
          deliver: async () => {
            await deliver();
          },
          failureNotice: this.catalog(ctx).home.recovery.unavailable,
        },
      );
      return;
    }
    await deliver();
  }

  private loadPage(page: number): Promise<SensorHistoryPage> {
    return this.historyTargets.execute({ page, pageSize: PAGE_SIZE });
  }

  private catalog(ctx: TelegramContext) {
    return ctx.localeState?.catalog ?? catalogFor('en');
  }

  private errorCopy(error: unknown): string {
    if (error instanceof SensorNotFoundError) return en.csv.notFound;
    if (error instanceof SensorLogExportRowTooLargeError) return en.csv.rowTooLarge;
    if (error instanceof CsvDocumentTooLargeError) return en.csv.fileTooLarge;
    if (error instanceof MalformedSensorLogTimestampError) return en.csv.malformedTimestamp;
    if (error instanceof SensorLogHistoryEmptyError) return en.csv.noRows;
    return en.csv.failed;
  }

  private logFailure(operation: string, error: unknown): void {
    const cause = error instanceof Error ? error : new Error(String(error));
    this.logger.error(`${operation} failed: ${cause.message}`, cause.stack);
  }
}

function parsePickerCallback(data: string): PickerCallback | null {
  const match = CSV_CALLBACK.exec(data);
  if (!match) return null;
  if (match[2] === 'p' && /^(0|[1-9]\d*)$/.test(match[3])) {
    return { receiptId: match[1], kind: 'page', page: Number(match[3]) };
  }
  const selection = /^(0|[1-9]\d*):(0|[1-9]\d*):([A-Za-z0-9_-]{12})$/.exec(match[3]);
  if (!selection || match[2] !== 's') return null;
  return {
    receiptId: match[1],
    kind: 'select',
    page: Number(selection[1]),
    index: Number(selection[2]),
    selector: selection[3],
  };
}

function selectorFor(id: string): string {
  return createHash('sha256').update(id).digest('base64url').slice(0, SELECTOR_LENGTH);
}
function selectionData(receiptId: string, page: number, index: number, id: string): string {
  return assertCallbackBytes(`csv:${receiptId}:s:${page}:${index}:${selectorFor(id)}`);
}
function pageData(receiptId: string, page: number): string {
  return assertCallbackBytes(`csv:${receiptId}:p:${page}`);
}
function assertCallbackBytes(data: string): string {
  if (Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_BYTES)
    throw new RangeError('CSV callback data exceeds Telegram limit');
  return data;
}
function targetLabel(target: SensorHistoryTarget): string {
  if (target.state === 'archived') return en.csv.archivedTarget(target.name);
  if (!target.enabled) return en.csv.disabledTarget(target.name);
  return `${TYPE_ICONS[target.type]} ${target.name}`;
}
function pickerKey(ctx: TelegramContext, receiptId: string): string {
  return `${ctx.from?.id ?? 'none'}:${ctx.chat?.id ?? 'none'}:${receiptId}`;
}
function uploadKey(ctx: TelegramContext, receiptId: string): string | null {
  if (ctx.from?.id === undefined || ctx.chat?.id === undefined) return null;
  return `${ctx.from.id}:${ctx.chat.id}:${receiptId}`;
}

import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Composer, InlineKeyboard, InputFile } from 'grammy';
import { catalogFor } from '../../locales';
import { en, TYPE_ICONS } from '../../locales/en';
import { ListSensorHistoryTargetsUseCase } from '../../sensors/application/list-sensor-history-targets.use-case';
import { MalformedSensorLogTimestampError } from '../../sensors/domain/errors/malformed-sensor-log-timestamp.error';
import { SensorLogHistoryEmptyError } from '../../sensors/domain/errors/sensor-log-history-empty.error';
import { SensorLogExportRowTooLargeError } from '../../sensors/domain/errors/sensor-log-export-row-too-large.error';
import { SensorNotFoundError } from '../../sensors/domain/errors/sensor-not-found.error';
import { SensorHistoryPage, SensorHistoryTarget } from '../../sensors/domain/ports/sensor-query.port';
import { StageCsvExportUseCase } from '../application/stage-csv-export.use-case';
import { CsvDocumentTooLargeError, CsvTempFile } from '../application/ports/csv-temp-file.port';
import { RoleMiddleware } from './role.middleware';
import { returnHomeKeyboard, type ExternalWorkflowPhase } from './return-home';
import { TelegramHandler } from './telegram-handler';
import { TelegramContext } from './telegram-context';

const DEFAULT_CSV_COUNT = 1000;
const MAX_CSV_COUNT = 5000;
const PAGE_SIZE = 20;
const SELECTOR_LENGTH = 12;
const MAX_CALLBACK_BYTES = 64;
const CSV_CALLBACK = /^csv:/;

type PickerOrigin = 'command' | 'menu';

type PickerCallback =
  | { readonly kind: 'page'; readonly origin: PickerOrigin; readonly page: number }
  | {
      readonly kind: 'select';
      readonly origin: PickerOrigin;
      readonly page: number;
      readonly index: number;
      readonly selector: string;
    };

/** Parse `/csv <sensor> [count]` while preserving the fixed 1–5000 limit. */
export function parseCsvArgs(raw: string): { name: string; count: number } | null {
  const [name, countToken, ...rest] = raw.trim().split(/\s+/).filter(Boolean);
  if (!name || rest.length > 0) return null;
  if (!countToken) return { name, count: DEFAULT_CSV_COUNT };
  if (!/^\d+$/.test(countToken)) return null;
  const count = Number(countToken);
  return Number.isSafeInteger(count) && count >= 1 && count <= MAX_CSV_COUNT
    ? { name, count }
    : null;
}

@Injectable()
export class CsvHandler implements TelegramHandler {
  private readonly logger = new Logger(CsvHandler.name);
  /** A consumed picker cannot launch another active upload; no timeout by design. */
  private readonly activeUploads = new Map<string, true>();

  constructor(
    private readonly historyTargets: ListSensorHistoryTargetsUseCase,
    private readonly stage: StageCsvExportUseCase,
    private readonly guard: RoleMiddleware,
  ) {}

  async handleEmpty(
    ctx: TelegramContext,
    origin: PickerOrigin = 'command',
    page = 0,
  ): Promise<void> {
    try {
      const historyPage = await this.loadPage(page);
      await this.replyPicker(ctx, origin, historyPage);
    } catch (error) {
      this.logFailure('CSV target picker', error);
      await this.replyTerminal(ctx, en.csv.failed);
    }
  }

  register(composer: Composer<TelegramContext>): void {
    composer.command('csv', this.guard.registered, async (ctx) => {
      await this.handleCommand(ctx);
    });
    composer.command('export_csv', this.guard.registered, async (ctx) => {
      await this.handleCommand(ctx);
    });
    composer.callbackQuery(CSV_CALLBACK, this.guard.registered, async (ctx) => {
      await this.handleCallback(ctx);
    });
  }

  private async handleCommand(ctx: TelegramContext): Promise<void> {
    const raw = (ctx.match ?? '').toString();
    if (!raw.trim()) {
      await this.handleEmpty(ctx, 'command');
      return;
    }

    const args = parseCsvArgs(raw);
    if (!args) {
      await this.replyTerminal(ctx, en.csv.invalidCount);
      return;
    }

    await this.startExport(ctx, { kind: 'name', name: args.name }, args.count, 'command');
  }

  private async handleCallback(ctx: TelegramContext): Promise<void> {
    await ctx.answerCallbackQuery().catch(() => undefined);
    const callback = parsePickerCallback(ctx.callbackQuery?.data ?? '');
    if (!callback) {
      await this.replyTerminal(ctx, en.csv.invalidSelection);
      return;
    }

    if (callback.kind === 'page') {
      await this.handlePage(ctx, callback);
      return;
    }

    await this.handleSelection(ctx, callback);
  }

  private async handlePage(
    ctx: TelegramContext,
    callback: Extract<PickerCallback, { kind: 'page' }>,
  ): Promise<void> {
    try {
      const historyPage = await this.loadPage(callback.page);
      await this.editPicker(ctx, callback.origin, historyPage);
    } catch (error) {
      this.logFailure('CSV picker page', error);
      await this.replyTerminal(ctx, en.csv.failed);
    }
  }

  private async handleSelection(
    ctx: TelegramContext,
    callback: Extract<PickerCallback, { kind: 'select' }>,
  ): Promise<void> {
    const lockKey = pickerLockKey(ctx);
    if (!lockKey) {
      await this.replyTerminal(ctx, en.csv.invalidSelection);
      await this.handleEmpty(ctx, callback.origin);
      return;
    }
    if (this.activeUploads.has(lockKey)) {
      await this.replyTerminal(ctx, en.csv.inProgress);
      return;
    }

    this.activeUploads.set(lockKey, true);
    let detached = false;
    try {
      const page = await this.loadPage(callback.page);
      const target = page.targets[callback.index];
      if (
        page.page !== callback.page ||
        !target ||
        selectorFor(target.id) !== callback.selector
      ) {
        await this.replyTerminal(ctx, en.csv.invalidSelection);
        await this.handleEmpty(ctx, callback.origin);
        return;
      }

      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      await this.replyStaging(ctx);
      this.detachExport(
        ctx,
        { kind: 'id', id: target.id },
        DEFAULT_CSV_COUNT,
        callback.origin,
        lockKey,
      );
      detached = true;
    } catch (error) {
      this.logFailure('CSV selection', error);
      await this.replyTerminal(ctx, this.errorCopy(error));
      await this.handleEmpty(ctx, callback.origin);
    } finally {
      if (!detached) this.activeUploads.delete(lockKey);
    }
  }

  private async startExport(
    ctx: TelegramContext,
    target: { readonly kind: 'name'; readonly name: string } | { readonly kind: 'id'; readonly id: string },
    count: number,
    origin: PickerOrigin,
  ): Promise<void> {
    await this.replyStaging(ctx);
    this.detachExport(ctx, target, count, origin);
  }

  private detachExport(
    ctx: TelegramContext,
    target: { readonly kind: 'name'; readonly name: string } | { readonly kind: 'id'; readonly id: string },
    count: number,
    origin: PickerOrigin,
    lockKey?: string,
  ): void {
    void this.runDetachedExport(ctx, target, count, origin, lockKey);
  }

  private async runDetachedExport(
    ctx: TelegramContext,
    target: { readonly kind: 'name'; readonly name: string } | { readonly kind: 'id'; readonly id: string },
    count: number,
    origin: PickerOrigin,
    lockKey?: string,
  ): Promise<void> {
    try {
      await this.stageAndUpload(ctx, target, count, origin);
    } catch (error) {
      this.logFailure('Detached CSV export', error);
    } finally {
      if (lockKey) this.activeUploads.delete(lockKey);
    }
  }

  private async stageAndUpload(
    ctx: TelegramContext,
    target: { readonly kind: 'name'; readonly name: string } | { readonly kind: 'id'; readonly id: string },
    count: number,
    origin: PickerOrigin,
  ): Promise<void> {
    let file: CsvTempFile | undefined;
    try {
      await ctx.replyWithChatAction('upload_document');
      file = await this.stage.execute({ target, limit: count });
      const staged = file;
      await ctx.replyWithDocument(
        new InputFile(() => staged.open(), staged.filename),
        {
          caption: en.csv.caption,
          reply_markup: this.keyboard(ctx, 'alreadyTerminal'),
        },
      );
    } catch (error) {
      const copy = this.errorCopy(error);
      if (copy === en.csv.failed) this.logFailure('CSV export', error);
      await this.replyTerminal(ctx, copy);
      await this.handleEmpty(ctx, origin);
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

  private async loadPage(page: number): Promise<SensorHistoryPage> {
    return this.historyTargets.execute({ page, pageSize: PAGE_SIZE });
  }

  private async replyPicker(
    ctx: TelegramContext,
    origin: PickerOrigin,
    page: SensorHistoryPage,
  ): Promise<void> {
    const keyboard = this.createPicker(ctx, origin, page);
    if (!keyboard) {
      await this.replyTerminal(ctx, en.csv.empty);
      return;
    }
    await ctx.reply(en.csv.selectTarget, { reply_markup: keyboard });
  }

  private async editPicker(
    ctx: TelegramContext,
    origin: PickerOrigin,
    page: SensorHistoryPage,
  ): Promise<void> {
    const keyboard = this.createPicker(ctx, origin, page);
    if (!keyboard) {
      await ctx.editMessageText(en.csv.empty, {
        reply_markup: this.keyboard(ctx, 'alreadyTerminal'),
      });
      return;
    }
    await ctx.editMessageText(en.csv.selectTarget, { reply_markup: keyboard });
  }

  private createPicker(
    ctx: TelegramContext,
    origin: PickerOrigin,
    page: SensorHistoryPage,
  ): InlineKeyboard | null {
    if (page.pageCount === 0) return null;

    const keyboard = new InlineKeyboard();
    page.targets.forEach((target, index) => {
      keyboard.text(targetLabel(target), selectionData(origin, page.page, index, target.id)).row();
    });
    if (page.page > 0) {
      keyboard.text(en.csv.previousPage, pageData(origin, page.page - 1));
    }
    if (page.page + 1 < page.pageCount) {
      keyboard.text(en.csv.nextPage, pageData(origin, page.page + 1));
    }
    keyboard.append(this.keyboard(ctx, 'cancelPending'));
    return keyboard;
  }

  private async replyStaging(ctx: TelegramContext): Promise<void> {
    await ctx.reply(this.catalog(ctx).csv.staging, {
      reply_markup: this.keyboard(ctx, 'leaveRunning'),
    });
  }

  private async replyTerminal(ctx: TelegramContext, text: string): Promise<void> {
    await ctx.reply(text, {
      reply_markup: this.keyboard(ctx, 'alreadyTerminal'),
    });
  }

  private keyboard(ctx: TelegramContext, phase: ExternalWorkflowPhase): InlineKeyboard {
    return returnHomeKeyboard(this.catalog(ctx), { workflow: 'csv', phase });
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
  const pageMatch = /^csv:page:(command|menu):(0|[1-9]\d*)$/.exec(data);
  if (pageMatch) {
    const page = safeNonNegativeInteger(pageMatch[2]);
    return page === null ? null : { kind: 'page', origin: pageMatch[1] as PickerOrigin, page };
  }

  const selectMatch = /^csv:select:(command|menu):(0|[1-9]\d*):(0|[1-9]\d*):([A-Za-z0-9_-]{12})$/.exec(data);
  if (!selectMatch) return null;
  const page = safeNonNegativeInteger(selectMatch[2]);
  const index = safeNonNegativeInteger(selectMatch[3]);
  if (page === null || index === null) return null;
  return {
    kind: 'select',
    origin: selectMatch[1] as PickerOrigin,
    page,
    index,
    selector: selectMatch[4],
  };
}

function safeNonNegativeInteger(value: string): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function selectorFor(id: string): string {
  return createHash('sha256').update(id).digest('base64url').slice(0, SELECTOR_LENGTH);
}

function selectionData(origin: PickerOrigin, page: number, index: number, id: string): string {
  return assertCallbackBytes(`csv:select:${origin}:${page}:${index}:${selectorFor(id)}`);
}

function pageData(origin: PickerOrigin, page: number): string {
  return assertCallbackBytes(`csv:page:${origin}:${page}`);
}

function assertCallbackBytes(data: string): string {
  if (Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_BYTES) {
    throw new RangeError('CSV callback data exceeds Telegram limit');
  }
  return data;
}

function targetLabel(target: SensorHistoryTarget): string {
  if (target.state === 'archived') return en.csv.archivedTarget(target.name);
  if (!target.enabled) return en.csv.disabledTarget(target.name);
  return `${TYPE_ICONS[target.type]} ${target.name}`;
}

function pickerLockKey(ctx: TelegramContext): string | null {
  const chatId = ctx.chat?.id;
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (chatId === undefined || messageId === undefined) return null;
  return `${chatId}:${messageId}`;
}

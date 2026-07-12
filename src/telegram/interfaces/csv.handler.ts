import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Composer, Context, InlineKeyboard, InputFile } from 'grammy';
import { en, TYPE_ICONS } from '../../locales/en';
import { ListSensorHistoryTargetsUseCase } from '../../sensors/application/list-sensor-history-targets.use-case';
import { MalformedSensorLogTimestampError } from '../../sensors/domain/errors/malformed-sensor-log-timestamp.error';
import { SensorLogExportRowTooLargeError } from '../../sensors/domain/errors/sensor-log-export-row-too-large.error';
import { SensorNotFoundError } from '../../sensors/domain/errors/sensor-not-found.error';
import { SensorHistoryPage, SensorHistoryTarget } from '../../sensors/domain/ports/sensor-query.port';
import { StageCsvExportUseCase } from '../application/stage-csv-export.use-case';
import { CsvDocumentTooLargeError, CsvTempFile } from '../application/ports/csv-temp-file.port';
import { RoleMiddleware } from './role.middleware';
import { TelegramHandler } from './telegram-handler';

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
    ctx: Context,
    origin: PickerOrigin = 'command',
    page = 0,
  ): Promise<void> {
    try {
      const historyPage = await this.loadPage(page);
      await this.replyPicker(ctx, origin, historyPage);
    } catch (error) {
      this.logFailure('CSV target picker', error);
      await ctx.reply(en.csv.failed);
    }
  }

  register(composer: Composer<Context>): void {
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

  private async handleCommand(ctx: Context): Promise<void> {
    const raw = (ctx.match ?? '').toString();
    if (!raw.trim()) {
      await this.handleEmpty(ctx, 'command');
      return;
    }

    const args = parseCsvArgs(raw);
    if (!args) {
      await ctx.reply(en.csv.invalidCount);
      return;
    }

    await this.stageAndUpload(ctx, { kind: 'name', name: args.name }, args.count, 'command');
  }

  private async handleCallback(ctx: Context): Promise<void> {
    await ctx.answerCallbackQuery().catch(() => undefined);
    const callback = parsePickerCallback(ctx.callbackQuery?.data ?? '');
    if (!callback) {
      await ctx.reply(en.csv.invalidSelection);
      return;
    }

    if (callback.kind === 'page') {
      await this.handlePage(ctx, callback);
      return;
    }

    await this.handleSelection(ctx, callback);
  }

  private async handlePage(
    ctx: Context,
    callback: Extract<PickerCallback, { kind: 'page' }>,
  ): Promise<void> {
    try {
      const historyPage = await this.loadPage(callback.page);
      await this.editPicker(ctx, callback.origin, historyPage);
    } catch (error) {
      this.logFailure('CSV picker page', error);
      await ctx.reply(en.csv.failed);
    }
  }

  private async handleSelection(
    ctx: Context,
    callback: Extract<PickerCallback, { kind: 'select' }>,
  ): Promise<void> {
    const lockKey = pickerLockKey(ctx);
    if (!lockKey) {
      await ctx.reply(en.csv.invalidSelection);
      await this.handleEmpty(ctx, callback.origin);
      return;
    }
    if (this.activeUploads.has(lockKey)) {
      await ctx.reply(en.csv.inProgress);
      return;
    }

    this.activeUploads.set(lockKey, true);
    try {
      const page = await this.loadPage(callback.page);
      const target = page.targets[callback.index];
      if (
        page.page !== callback.page ||
        !target ||
        selectorFor(target.id) !== callback.selector
      ) {
        await ctx.reply(en.csv.invalidSelection);
        await this.handleEmpty(ctx, callback.origin);
        return;
      }

      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      await this.stageAndUpload(
        ctx,
        { kind: 'id', id: target.id },
        DEFAULT_CSV_COUNT,
        callback.origin,
      );
    } catch (error) {
      this.logFailure('CSV selection', error);
      await ctx.reply(this.errorCopy(error));
      await this.handleEmpty(ctx, callback.origin);
    } finally {
      this.activeUploads.delete(lockKey);
    }
  }

  private async stageAndUpload(
    ctx: Context,
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
        { caption: en.csv.caption },
      );
    } catch (error) {
      const copy = this.errorCopy(error);
      if (copy === en.csv.failed) this.logFailure('CSV export', error);
      await ctx.reply(copy);
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
    ctx: Context,
    origin: PickerOrigin,
    page: SensorHistoryPage,
  ): Promise<void> {
    const keyboard = this.createPicker(origin, page);
    if (!keyboard) {
      await ctx.reply(en.csv.empty);
      return;
    }
    await ctx.reply(en.csv.selectTarget, { reply_markup: keyboard });
  }

  private async editPicker(
    ctx: Context,
    origin: PickerOrigin,
    page: SensorHistoryPage,
  ): Promise<void> {
    const keyboard = this.createPicker(origin, page);
    if (!keyboard) {
      await ctx.editMessageText(en.csv.empty, { reply_markup: undefined });
      return;
    }
    await ctx.editMessageText(en.csv.selectTarget, { reply_markup: keyboard });
  }

  private createPicker(origin: PickerOrigin, page: SensorHistoryPage): InlineKeyboard | null {
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
    return keyboard;
  }

  private errorCopy(error: unknown): string {
    if (error instanceof SensorNotFoundError) return en.csv.notFound;
    if (error instanceof SensorLogExportRowTooLargeError) return en.csv.rowTooLarge;
    if (error instanceof CsvDocumentTooLargeError) return en.csv.fileTooLarge;
    if (error instanceof MalformedSensorLogTimestampError) return en.csv.malformedTimestamp;
    if (hasCode(error, 'SENSOR_LOG_HISTORY_EMPTY')) return en.csv.noRows;
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
  if (!target.enabled) return en.csv.disabledTarget(target.name);
  if (target.state === 'archived') return en.csv.archivedTarget(target.name);
  return `${TYPE_ICONS[target.type]} ${target.name}`;
}

function pickerLockKey(ctx: Context): string | null {
  const chatId = ctx.chat?.id;
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (chatId === undefined || messageId === undefined) return null;
  return `${chatId}:${messageId}`;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

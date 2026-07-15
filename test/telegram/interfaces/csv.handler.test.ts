import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CsvDocumentTooLargeError, CsvTempFile } from '../../../src/telegram/application/ports/csv-temp-file.port';
import { CsvHandler, parseCsvArgs } from '../../../src/telegram/interfaces/csv.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import { SensorNotFoundError } from '../../../src/sensors/domain/errors/sensor-not-found.error';
import { SensorLogExportRowTooLargeError } from '../../../src/sensors/domain/errors/sensor-log-export-row-too-large.error';
import { MalformedSensorLogTimestampError } from '../../../src/sensors/domain/errors/malformed-sensor-log-timestamp.error';
import { SensorLogHistoryEmptyError } from '../../../src/sensors/domain/errors/sensor-log-history-empty.error';
import { catalogFor } from '../../../src/locales';
import { en } from '../../../src/locales/en';

const target = {
  id: 'current-id',
  name: 'Kitchen temperature',
  type: 'uart' as const,
  enabled: true,
  state: 'current' as const,
  archivedAt: null,
};

function selector(id: string): string {
  return createHash('sha256').update(id).digest('base64url').slice(0, 12);
}

function createSetup() {
  const list = {
    execute: vi.fn().mockResolvedValue({ targets: [target], page: 0, pageCount: 1 }),
  };
  const file: CsvTempFile = {
    filename: 'kitchen.csv',
    open: vi.fn(() => Readable.from('csv')),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  const stage = { execute: vi.fn().mockResolvedValue(file) };
  const guard = { registered: vi.fn() } as unknown as RoleMiddleware;
  const handler = new CsvHandler(list, stage, guard);
  const commandCallbacks = new Map<string, (ctx: Record<string, unknown>) => Promise<void>>();
  let callback: ((ctx: Record<string, unknown>) => Promise<void>) | undefined;
  const composer = {
    command: vi.fn((command: string, _guard: unknown, fn: (ctx: Record<string, unknown>) => Promise<void>) => {
      commandCallbacks.set(command, fn);
    }),
    callbackQuery: vi.fn((_filter: RegExp, _guard: unknown, fn: (ctx: Record<string, unknown>) => Promise<void>) => {
      callback = fn;
    }),
  };
  handler.register(composer as never);
  return { callback, commandCallbacks, composer, file, guard, handler, list, stage };
}

function callbackData(options: unknown): string[] {
  if (!options || typeof options !== 'object') return [];
  const replyMarkup = (options as {
    reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    inline_keyboard?: Array<Array<{ callback_data?: string }>>;
  }).reply_markup ?? options as { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
  return replyMarkup.inline_keyboard?.flat()
    .map((button) => button.callback_data)
    .filter((data): data is string => typeof data === 'string') ?? [];
}

function keyboardText(options: unknown): string[] {
  if (!options || typeof options !== 'object') return [];
  const replyMarkup = (options as {
    reply_markup?: { inline_keyboard?: Array<Array<{ text?: string }>> };
    inline_keyboard?: Array<Array<{ text?: string }>>;
  }).reply_markup ?? options as { inline_keyboard?: Array<Array<{ text?: string }>> };
  return replyMarkup.inline_keyboard?.flat()
    .map((button) => button.text)
    .filter((text): text is string => typeof text === 'string') ?? [];
}

function replyOptions(ctx: { reply: ReturnType<typeof vi.fn> }, text: string): unknown {
  return ctx.reply.mock.calls.find(([message]) => message === text)?.[1];
}

function commandContext(match: string, locale?: 'en' | 'ru' | 'uk') {
  return {
    match,
    localeState: locale ? { catalog: catalogFor(locale) } : undefined,
    reply: vi.fn().mockResolvedValue(true),
    replyWithChatAction: vi.fn().mockResolvedValue(true),
    replyWithDocument: vi.fn().mockResolvedValue(true),
  };
}

function callbackContext(data: string, messageId = 50, locale?: 'en' | 'ru' | 'uk') {
  return {
    from: { id: 7 },
    chat: { id: 11 },
    callbackQuery: { data, message: { message_id: messageId } },
    localeState: locale ? { catalog: catalogFor(locale) } : undefined,
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    editMessageText: vi.fn().mockResolvedValue(true),
    replyWithChatAction: vi.fn().mockResolvedValue(true),
    replyWithDocument: vi.fn().mockResolvedValue(true),
    reply: vi.fn().mockResolvedValue(true),
  };
}

describe('parseCsvArgs', () => {
  it.each([
    ['kitchen', { name: 'kitchen', count: 1000 }],
    ['kitchen 5000', { name: 'kitchen', count: 5000 }],
  ])('parses %s', (raw, expected) => {
    expect(parseCsvArgs(raw)).toEqual(expected);
  });

  it.each(['', 'kitchen 0', 'kitchen 5001', 'kitchen nope', 'kitchen 1 extra'])(
    'rejects invalid input %s',
    (raw) => {
      expect(parseCsvArgs(raw)).toBeNull();
    },
  );
});

describe('CsvHandler', () => {
  it('registers both commands and CSV callbacks behind registered-user guard', () => {
    const { composer, guard } = createSetup();

    expect(composer.command).toHaveBeenCalledWith('csv', guard.registered, expect.anything());
    expect(composer.command).toHaveBeenCalledWith('export_csv', guard.registered, expect.anything());
    expect(composer.callbackQuery).toHaveBeenCalledWith(expect.any(RegExp), guard.registered, expect.anything());
  });

  it('renders a localized picker with a cancel-pending Return Home row', async () => {
    const { commandCallbacks, list } = createSetup();
    list.execute.mockResolvedValueOnce({
      targets: [{ ...target, enabled: false }],
      page: 0,
      pageCount: 1,
    });
    const ctx = commandContext('', 'uk');

    await commandCallbacks.get('csv')?.(ctx);

    expect(list.execute).toHaveBeenCalledWith({ page: 0, pageSize: 20 });
    const keyboard = ctx.reply.mock.calls[0][1].reply_markup;
    expect(JSON.stringify(keyboard)).toContain('⏸️ Kitchen temperature (disabled)');
    expect(JSON.stringify(keyboard)).toContain(`csv:select:command:0:0:${selector(target.id)}`);
    expect(callbackData(keyboard)).toContain('rh:c:c');
    expect(keyboardText(keyboard)).toContain('🏠 Дім');
    expect(callbackData(keyboard).every((data) => Buffer.byteLength(data, 'utf8') <= 64)).toBe(true);
  });

  it('renders archived targets with the archived label', async () => {
    const { commandCallbacks, list } = createSetup();
    list.execute.mockResolvedValueOnce({
      targets: [{ ...target, enabled: false, state: 'archived', archivedAt: 123 }],
      page: 0,
      pageCount: 1,
    });
    const ctx = commandContext('');

    await commandCallbacks.get('csv')?.(ctx);

    const keyboard = ctx.reply.mock.calls[0][1].reply_markup;
    expect(JSON.stringify(keyboard)).toContain('🗄️ Kitchen temperature (archived)');
  });

  it('returns from a named export before deferred staging completes', async () => {
    const { commandCallbacks, stage } = createSetup();
    const deferredFile: CsvTempFile = {
      filename: 'late.csv',
      open: vi.fn(() => Readable.from('csv')),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    let release!: () => void;
    stage.execute.mockImplementationOnce(
      () => new Promise<CsvTempFile>((resolve) => { release = () => resolve(deferredFile); }),
    );
    const ctx = commandContext('Kitchen 5000', 'uk');

    const command = commandCallbacks.get('csv')!;
    const commandPromise = command(ctx);
    await vi.waitFor(() => expect(stage.execute).toHaveBeenCalledOnce());
    let returned = false;
    void commandPromise.then(() => { returned = true; });
    await Promise.resolve();
    const returnedBeforeStageRelease = returned;
    release();
    await commandPromise;

    expect(stage.execute).toHaveBeenCalledWith({
      target: { kind: 'name', name: 'Kitchen' },
      limit: 5000,
    });
    expect(returnedBeforeStageRelease).toBe(true);
    expect(ctx.reply).toHaveBeenCalledWith(
      catalogFor('uk').csv.staging,
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(callbackData(replyOptions(ctx, catalogFor('uk').csv.staging))).toContain('rh:c:r');
  });

  it('resolves a verified short selector, clears markup, uploads, and disposes the file', async () => {
    const { callback, file, stage } = createSetup();
    const ctx = callbackContext(`csv:select:command:0:0:${selector(target.id)}`);

    await callback?.(ctx);
    await vi.waitFor(() => expect(ctx.replyWithDocument).toHaveBeenCalledOnce());

    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ reply_markup: undefined });
    expect(ctx.replyWithChatAction).toHaveBeenCalledWith('upload_document');
    expect(stage.execute).toHaveBeenCalledWith({ target: { kind: 'id', id: 'current-id' }, limit: 1000 });
    expect(ctx.replyWithDocument).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ caption: en.csv.caption, reply_markup: expect.anything() }),
    );
    expect(callbackData(ctx.replyWithDocument.mock.calls[0][1])).toContain('rh:c:t');
    expect(file.dispose).toHaveBeenCalledOnce();
  });

  it('reloads the requested page and rejects a stale selector without staging', async () => {
    const { callback, list, stage } = createSetup();
    list.execute.mockResolvedValueOnce({
      targets: [{ ...target, id: 'new-id' }],
      page: 0,
      pageCount: 1,
    });
    const ctx = callbackContext(`csv:select:command:0:0:${selector(target.id)}`);

    await callback?.(ctx);

    expect(list.execute).toHaveBeenCalledWith({ page: 0, pageSize: 20 });
    expect(stage.execute).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      en.csv.invalidSelection,
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(callbackData(replyOptions(ctx, en.csv.invalidSelection))).toContain('rh:c:t');
    expect(callbackData(replyOptions(ctx, en.csv.selectTarget))).toContain('rh:c:c');
  });

  it('rejects a callback page that the server clamps to another page', async () => {
    const { callback, list, stage } = createSetup();
    list.execute.mockResolvedValueOnce({ targets: [target], page: 0, pageCount: 1 });
    const ctx = callbackContext(`csv:select:command:1:0:${selector(target.id)}`);

    await callback?.(ctx);

    expect(stage.execute).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      en.csv.invalidSelection,
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });

  it('returns from a picker selection before staging settles and keeps the leave-running lock', async () => {
    const { callback, stage } = createSetup();
    const deferredFile: CsvTempFile = {
      filename: 'late.csv',
      open: vi.fn(() => Readable.from('csv')),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    let release!: () => void;
    stage.execute.mockImplementationOnce(
      () => new Promise<CsvTempFile>((resolve) => { release = () => resolve(deferredFile); }),
    );
    const data = `csv:select:command:0:0:${selector(target.id)}`;
    const first = callbackContext(data);
    const second = callbackContext(data);

    const firstPromise = callback?.(first);
    await vi.waitFor(() => expect(stage.execute).toHaveBeenCalledOnce());
    let returned = false;
    void firstPromise?.then(() => { returned = true; });
    await Promise.resolve();
    const returnedBeforeStageRelease = returned;
    await callback?.(second);
    expect(second.reply).toHaveBeenCalledWith(
      en.csv.inProgress,
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(stage.execute).toHaveBeenCalledOnce();
    expect(first.reply).toHaveBeenCalledWith(
      en.csv.staging,
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    const stagingOptions = replyOptions(first, en.csv.staging);
    expect(callbackData(stagingOptions)).toContain('rh:c:r');
    expect(callbackData(stagingOptions)).not.toContain('csv:cancel');
    expect(returnedBeforeStageRelease).toBe(true);

    release();
    await firstPromise;
    await vi.waitFor(() => expect(first.replyWithDocument).toHaveBeenCalledOnce());
    const third = callbackContext(data);
    await callback?.(third);
    await vi.waitFor(() => expect(stage.execute).toHaveBeenCalledTimes(2));
  });

  it('adds terminal Return Home for empty history and invalid commands', async () => {
    const { commandCallbacks, list, stage } = createSetup();
    list.execute.mockResolvedValueOnce({ targets: [], page: 0, pageCount: 0 });
    const emptyContext = commandContext('');

    await commandCallbacks.get('csv')?.(emptyContext);

    expect(callbackData(replyOptions(emptyContext, en.csv.empty))).toContain('rh:c:t');

    const invalidContext = commandContext('Kitchen 0');
    await commandCallbacks.get('csv')?.(invalidContext);

    expect(stage.execute).not.toHaveBeenCalled();
    expect(callbackData(replyOptions(invalidContext, en.csv.invalidCount))).toContain('rh:c:t');
  });

  it('keeps terminal Return Home when a picker page becomes empty', async () => {
    const { callback, list } = createSetup();
    list.execute.mockResolvedValueOnce({ targets: [], page: 0, pageCount: 0 });
    const ctx = callbackContext('csv:page:command:0');

    await callback?.(ctx);

    expect(ctx.editMessageText).toHaveBeenCalledWith(
      en.csv.empty,
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(callbackData(ctx.editMessageText.mock.calls[0][1])).toContain('rh:c:t');
  });

  it.each([
    [new SensorNotFoundError('missing'), en.csv.notFound],
    [new SensorLogExportRowTooLargeError(2, 1), en.csv.rowTooLarge],
    [new CsvDocumentTooLargeError(2, 1), en.csv.fileTooLarge],
    [new MalformedSensorLogTimestampError('s1'), en.csv.malformedTimestamp],
    [new SensorLogHistoryEmptyError('current-id'), en.csv.noRows],
  ])('maps export failures to the matching CSV copy', async (error, expected) => {
    const { callback, stage } = createSetup();
    stage.execute.mockRejectedValueOnce(error);
    const ctx = callbackContext(`csv:select:command:0:0:${selector(target.id)}`);

    await callback?.(ctx);
    await vi.waitFor(() => expect(ctx.reply).toHaveBeenCalledWith(expected, expect.anything()));

    expect(callbackData(replyOptions(ctx, expected))).toContain('rh:c:t');
    await vi.waitFor(() => {
      expect(callbackData(replyOptions(ctx, en.csv.selectTarget))).toContain('rh:c:c');
    });
  });

  it('catches detached direct export failures and renders a terminal response', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { commandCallbacks, stage } = createSetup();
    stage.execute.mockRejectedValueOnce(new Error('staging unavailable'));
    const ctx = commandContext('Kitchen');

    try {
      await commandCallbacks.get('csv')?.(ctx);
      await vi.waitFor(() => expect(ctx.reply).toHaveBeenCalledWith(en.csv.failed, expect.anything()));

      expect(callbackData(replyOptions(ctx, en.csv.failed))).toContain('rh:c:t');
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('CSV export failed: staging unavailable'),
        expect.anything(),
      );
    } finally {
      error.mockRestore();
    }
  });
});

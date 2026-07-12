import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CsvDocumentTooLargeError, CsvTempFile } from '../../../src/telegram/application/ports/csv-temp-file.port';
import { CsvHandler, parseCsvArgs } from '../../../src/telegram/interfaces/csv.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import { SensorNotFoundError } from '../../../src/sensors/domain/errors/sensor-not-found.error';
import { SensorLogExportRowTooLargeError } from '../../../src/sensors/domain/errors/sensor-log-export-row-too-large.error';
import { MalformedSensorLogTimestampError } from '../../../src/sensors/domain/errors/malformed-sensor-log-timestamp.error';
import { SensorLogHistoryEmptyError } from '../../../src/sensors/domain/errors/sensor-log-history-empty.error';
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

function callbackContext(data: string, messageId = 50) {
  return {
    from: { id: 7 },
    chat: { id: 11 },
    callbackQuery: { data, message: { message_id: messageId } },
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
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

  it('renders a picker for an empty command and labels disabled targets exactly', async () => {
    const { commandCallbacks, list } = createSetup();
    list.execute.mockResolvedValueOnce({
      targets: [{ ...target, enabled: false }],
      page: 0,
      pageCount: 1,
    });
    const ctx = { match: '', reply: vi.fn().mockResolvedValue(true) };

    await commandCallbacks.get('csv')?.(ctx);

    expect(list.execute).toHaveBeenCalledWith({ page: 0, pageSize: 20 });
    const keyboard = ctx.reply.mock.calls[0][1].reply_markup;
    expect(JSON.stringify(keyboard)).toContain('⏸️ Kitchen temperature (disabled)');
    expect(JSON.stringify(keyboard)).toContain(`csv:select:command:0:0:${selector(target.id)}`);
    const callbackData = (keyboard as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard.flat().map((button) => button.callback_data);
    expect(callbackData.every((data) => Buffer.byteLength(data, 'utf8') <= 64)).toBe(true);
  });

  it('exports a named target with the requested bounded count', async () => {
    const { commandCallbacks, stage } = createSetup();
    const ctx = {
      match: 'Kitchen 5000',
      reply: vi.fn().mockResolvedValue(true),
      replyWithChatAction: vi.fn().mockResolvedValue(true),
      replyWithDocument: vi.fn().mockResolvedValue(true),
    };

    await commandCallbacks.get('csv')?.(ctx);

    expect(stage.execute).toHaveBeenCalledWith({
      target: { kind: 'name', name: 'Kitchen' },
      limit: 5000,
    });
  });

  it('resolves a verified short selector, clears markup, uploads, and disposes the file', async () => {
    const { callback, file, stage } = createSetup();
    const ctx = callbackContext(`csv:select:command:0:0:${selector(target.id)}`);

    await callback?.(ctx);

    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ reply_markup: undefined });
    expect(ctx.replyWithChatAction).toHaveBeenCalledWith('upload_document');
    expect(stage.execute).toHaveBeenCalledWith({ target: { kind: 'id', id: 'current-id' }, limit: 1000 });
    expect(ctx.replyWithDocument).toHaveBeenCalledWith(expect.anything(), { caption: en.csv.caption });
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
    expect(ctx.reply).toHaveBeenCalledWith(en.csv.invalidSelection);
  });

  it('rejects a callback page that the server clamps to another page', async () => {
    const { callback, list, stage } = createSetup();
    list.execute.mockResolvedValueOnce({ targets: [target], page: 0, pageCount: 1 });
    const ctx = callbackContext(`csv:select:command:1:0:${selector(target.id)}`);

    await callback?.(ctx);

    expect(stage.execute).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(en.csv.invalidSelection);
  });

  it('keeps the active upload lock until the first upload settles, then permits retry', async () => {
    const { callback, stage } = createSetup();
    let release!: () => void;
    stage.execute.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ filename: 'late.csv', open: () => Readable.from('csv'), dispose: vi.fn().mockResolvedValue(undefined) }); }),
    );
    const data = `csv:select:command:0:0:${selector(target.id)}`;
    const first = callbackContext(data);
    const second = callbackContext(data);

    const firstPromise = callback?.(first);
    await vi.waitFor(() => expect(stage.execute).toHaveBeenCalledOnce());
    await callback?.(second);
    expect(second.reply).toHaveBeenCalledWith(en.csv.inProgress);

    release();
    await firstPromise;
    const third = callbackContext(data);
    await callback?.(third);
    expect(stage.execute).toHaveBeenCalledTimes(2);
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

    expect(ctx.reply).toHaveBeenCalledWith(expected);
    expect(ctx.reply).toHaveBeenCalledWith(en.csv.selectTarget, expect.anything());
  });
});

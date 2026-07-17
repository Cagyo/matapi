import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';
import type { CsvTempFile } from '../../../src/telegram/application/ports/csv-temp-file.port';
import { CsvHandler, parseCsvArgs } from '../../../src/telegram/interfaces/csv.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import type { WorkflowEntryCoordinator } from '../../../src/telegram/interfaces/workflow-entry.coordinator';
import type { WorkflowNavigationHandler } from '../../../src/telegram/interfaces/workflow-navigation.handler';

const receipt = {
  id: 'abcdefghijklmnop',
  userId: 7,
  chatId: 11,
  kind: 'workflow-return',
  sessionToken: null,
  status: 'pending',
  expiresAt: new Date('2030-01-01'),
  payload: {
    workflow: 'csv',
    phase: 'cancellable',
    originSource: 'captured',
    origin: { kind: 'history' },
  },
} satisfies WorkflowReturnReceipt;

const target = {
  id: 'current-id',
  name: 'Kitchen temperature',
  type: 'uart' as const,
  enabled: true,
  state: 'current' as const,
  archivedAt: null,
};

type Handler = (ctx: Record<string, unknown>) => Promise<void>;

function setup() {
  const historyTargets = {
    execute: vi.fn().mockResolvedValue({ targets: [target], page: 0, pageCount: 1 }),
  };
  const file: CsvTempFile = {
    filename: 'kitchen.csv',
    open: vi.fn(() => Readable.from('csv')),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  const stage = { execute: vi.fn().mockResolvedValue(file) };
  const workflows = {
    begin: vi.fn().mockResolvedValue(receipt),
    validateCurrent: vi.fn().mockResolvedValue(true),
    markRunning: vi.fn().mockResolvedValue(true),
  };
  const navigation = {
    complete: vi.fn(async (_ctx, _launch, presentation) => {
      await presentation.deliver();
    }),
  };
  const handler = new CsvHandler(
    historyTargets as never,
    stage as never,
    { registered: vi.fn() } as unknown as RoleMiddleware,
    workflows as unknown as WorkflowEntryCoordinator,
    navigation as unknown as WorkflowNavigationHandler,
  );
  const commands = new Map<string, Handler>();
  let callback: Handler | undefined;
  handler.register({
    command: vi.fn((name: string, _guard: unknown, fn: Handler) => commands.set(name, fn)),
    callbackQuery: vi.fn((_filter: RegExp, _guard: unknown, fn: Handler) => {
      callback = fn;
    }),
  } as never);
  return {
    callback: callback!,
    commands,
    file,
    handler,
    historyTargets,
    navigation,
    stage,
    workflows,
  };
}

function context(input: { match?: string; callback?: string } = {}) {
  return {
    from: { id: 7 },
    chat: { id: 11, type: 'private' },
    match: input.match ?? '',
    callbackQuery: input.callback ? { data: input.callback, message: { message_id: 99 } } : undefined,
    localeState: {
      locale: 'en',
      catalog: catalogFor('en'),
      user: { telegramId: 7, role: 'user' },
    },
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    editMessageText: vi.fn().mockResolvedValue(true),
    reply: vi.fn().mockResolvedValue(true),
    replyWithChatAction: vi.fn().mockResolvedValue(true),
    replyWithDocument: vi.fn().mockResolvedValue(true),
  };
}

function keyboardData(ctx: ReturnType<typeof context>): string[] {
  const keyboard = ctx.reply.mock.calls[0]?.[1]?.reply_markup as
    | { inline_keyboard?: { callback_data?: string }[][] }
    | undefined;
  return keyboard?.inline_keyboard?.flat().flatMap((button) => button.callback_data ?? []) ?? [];
}

describe('parseCsvArgs', () => {
  it.each([
    ['kitchen', { name: 'kitchen', count: 1000 }],
    ['kitchen 5000', { name: 'kitchen', count: 5000 }],
  ])('parses %s', (raw, expected) => expect(parseCsvArgs(raw)).toEqual(expected));
  it.each(['', 'kitchen 0', 'kitchen 5001', 'kitchen nope', 'kitchen 1 extra'])('rejects %s', (raw) =>
    expect(parseCsvArgs(raw)).toBeNull(),
  );
});

describe('CsvHandler contextual navigation', () => {
  it('uses History as the direct parent and receipt-bound target callbacks', async () => {
    const { commands, workflows } = setup();
    const ctx = context();
    await commands.get('csv')?.(ctx);

    expect(workflows.begin).toHaveBeenCalledWith(ctx, 'csv', {
      source: 'natural-parent',
    });
    const data = keyboardData(ctx);
    expect(data).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^csv:abcdefghijklmnop:s:0:0:[A-Za-z0-9_-]{12}$/),
        'wr:abcdefghijklmnop:o',
      ]),
    );
    expect(data.every((value) => Buffer.byteLength(value, 'utf8') <= 64)).toBe(true);
  });

  it('rejects stale picker callbacks before loading target state or staging', async () => {
    const { callback, commands, historyTargets, stage, workflows } = setup();
    const picker = context();
    await commands.get('csv')?.(picker);
    workflows.validateCurrent.mockResolvedValueOnce(false);
    const stale = context({
      callback: keyboardData(picker).find((data) => data.startsWith('csv:'))!,
    });

    await callback(stale);

    expect(historyTargets.execute).toHaveBeenCalledTimes(1);
    expect(stage.execute).not.toHaveBeenCalled();
    expect(stale.reply).not.toHaveBeenCalled();
  });

  it('marks the receipt running immediately before detached staging and retains a receipt lock', async () => {
    const { callback, commands, stage, workflows } = setup();
    let release!: (file: CsvTempFile) => void;
    stage.execute.mockImplementationOnce(
      () =>
        new Promise<CsvTempFile>((resolve) => {
          release = resolve;
        }),
    );
    const picker = context();
    await commands.get('csv')?.(picker);
    const selected = context({
      callback: keyboardData(picker).find((data) => data.startsWith('csv:'))!,
    });

    await callback(selected);
    await vi.waitFor(() => expect(stage.execute).toHaveBeenCalledOnce());

    expect(workflows.markRunning).toHaveBeenCalledWith(selected, receipt);
    expect(selected.reply.mock.calls[0][0]).toBe(catalogFor('en').csv.staging);
    const stagingData = selected.reply.mock.calls[0][1].reply_markup.inline_keyboard[0][0].callback_data;
    expect(stagingData).toBe('wr:abcdefghijklmnop:o');
    release({
      filename: 'late.csv',
      open: vi.fn(() => Readable.from('csv')),
      dispose: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('delivers a later successful upload through workflow completion, allowing returned receipts to stay on Home', async () => {
    const { callback, commands, navigation } = setup();
    const picker = context();
    await commands.get('csv')?.(picker);
    const selected = context({
      callback: keyboardData(picker).find((data) => data.startsWith('csv:'))!,
    });
    await callback(selected);
    await vi.waitFor(() => expect(selected.replyWithDocument).toHaveBeenCalledOnce());

    expect(navigation.complete).toHaveBeenCalledWith(
      selected,
      { receipt },
      expect.objectContaining({ effectStage: 'pending' }),
    );
  });
});

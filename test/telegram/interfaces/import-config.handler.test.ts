import { describe, expect, it, vi } from 'vitest';
import { en } from '../../../src/locales/en';
import { catalogFor } from '../../../src/locales';
import type { ImportCameraLiveSourcesUseCase } from '../../../src/telegram/application/import-camera-live-sources.use-case';
import type { ImportSensorsUseCase } from '../../../src/sensors/application/import-sensors.use-case';
import type { ConfigCodecPort } from '../../../src/telegram/domain/ports/config-codec.port';
import type { UserRepositoryPort } from '../../../src/telegram/domain/ports/user-repository.port';
import { ImportConfigHandler } from '../../../src/telegram/interfaces/import-config.handler';
import type { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import type { TelegramContext } from '../../../src/telegram/interfaces/telegram-context';

const sensorPlan = {
  batch: { inserts: [], updates: [], archives: [] },
  summary: { added: ['sensor'], updated: [], archived: [] },
};
const cameraPlan = { sources: [], configured: ['front_door'] };

function fixture(roles: ('admin' | 'user')[] = ['admin', 'admin']) {
  const order: string[] = [];
  const importSensors = {
    commit: vi.fn(async () => {
      order.push('sensors');
      return sensorPlan.summary;
    }),
  } as unknown as ImportSensorsUseCase;
  const importCameraSources = {
    commit: vi.fn(async () => {
      order.push('cameras');
      return cameraPlan.configured;
    }),
  } as unknown as ImportCameraLiveSourcesUseCase;
  const users = {
    findByTelegramId: vi.fn(async () => {
      order.push('role');
      const role = roles.shift() ?? 'user';
      return { role };
    }),
  } as unknown as UserRepositoryPort;
  const handler = new ImportConfigHandler(
    importSensors,
    importCameraSources,
    {} as ConfigCodecPort,
    {} as RoleMiddleware,
    users,
  );
  const states = (handler as unknown as {
    states: Map<number, unknown>;
  }).states;
  states.set(42, { kind: 'awaitingConfirm', sensorPlan, cameraPlan });
  const ctx = {
    from: { id: 42 },
    callbackQuery: { data: 'imp:apply' },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    localeState: {
      catalog: en,
      locale: 'en',
      user: { role: 'admin' },
    },
  } as unknown as TelegramContext;
  return { handler, importSensors, importCameraSources, users, ctx, order };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function apply(handler: ImportConfigHandler, ctx: TelegramContext) {
  await (handler as unknown as {
    onCallback(context: TelegramContext): Promise<void>;
  }).onCallback(ctx);
}

function callbackData(reply: ReturnType<typeof vi.fn>, index = reply.mock.calls.length - 1): string[] {
  return reply.mock.calls[index]?.[1]?.reply_markup?.inline_keyboard?.flat()
    .map((button: { callback_data?: string }) => button.callback_data)
    .filter((data: string | undefined): data is string => typeof data === 'string') ?? [];
}

function keyboardRows(reply: ReturnType<typeof vi.fn>, index = reply.mock.calls.length - 1) {
  return reply.mock.calls[index]?.[1]?.reply_markup?.inline_keyboard ?? [];
}

function documentFixture() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    text: vi.fn().mockResolvedValue('sensors: []'),
  }));
  const importSensors = {
    prepare: vi.fn().mockResolvedValue(sensorPlan),
    commit: vi.fn().mockResolvedValue(sensorPlan.summary),
  } as unknown as ImportSensorsUseCase;
  const importCameraSources = {
    prepare: vi.fn().mockResolvedValue(cameraPlan),
    commit: vi.fn().mockResolvedValue(cameraPlan.configured),
  } as unknown as ImportCameraLiveSourcesUseCase;
  const codec = { parse: vi.fn().mockReturnValue({ sensors: [] }) } as unknown as ConfigCodecPort;
  const handler = new ImportConfigHandler(
    importSensors,
    importCameraSources,
    codec,
    {} as RoleMiddleware,
    { findByTelegramId: vi.fn().mockResolvedValue({ role: 'admin' }) } as unknown as UserRepositoryPort,
  );
  const reply = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    from: { id: 42 },
    message: { document: { file_name: 'config.yml', file_size: 100 } },
    getFile: vi.fn().mockResolvedValue({ file_path: 'config.yml' }),
    reply,
    localeState: { catalog: catalogFor('uk') },
  } as unknown as TelegramContext;
  return { handler, importSensors, importCameraSources, codec, ctx, reply };
}

async function document(handler: ImportConfigHandler, ctx: TelegramContext) {
  await (handler as unknown as {
    onDocument(context: TelegramContext, userId: number): Promise<void>;
  }).onDocument(ctx, 42);
}

describe('ImportConfigHandler live-source confirmation', () => {
  it('claims confirmation before a deferred role lookup so concurrent Apply commits once', async () => {
    const {
      handler,
      ctx,
      users,
      importSensors,
      importCameraSources,
      order,
    } = fixture();
    const firstRole = deferred<{ role: 'admin' }>();
    vi.mocked(users.findByTelegramId)
      .mockImplementationOnce(() => {
        order.push('role');
        return firstRole.promise as never;
      })
      .mockImplementationOnce(async () => {
        order.push('role');
        return { role: 'admin' } as never;
      });

    const firstApply = apply(handler, ctx);
    await vi.waitFor(() =>
      expect(users.findByTelegramId).toHaveBeenCalledOnce(),
    );
    const replayedApply = apply(handler, ctx);
    await replayedApply;
    expect(ctx.reply).toHaveBeenCalledWith(
      en.common.interrupted,
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    firstRole.resolve({ role: 'admin' });
    await firstApply;

    expect(importCameraSources.commit).toHaveBeenCalledOnce();
    expect(importSensors.commit).toHaveBeenCalledOnce();
    expect(order).toEqual(['role', 'cameras', 'role', 'sensors']);
    expect(callbackData(ctx.reply, 0)).toEqual(['rh:i:t']);
    expect(callbackData(ctx.reply, 1)).toEqual(['rh:i:t']);
  });

  it('uses one confirmation, rechecks admin before each camera-first write phase', async () => {
    const { handler, ctx, order } = fixture();
    await apply(handler, ctx);
    expect(order).toEqual(['role', 'cameras', 'role', 'sensors']);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('1 live sources configured without credentials'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(callbackData(ctx.reply)).toEqual(['rh:i:t']);
  });

  it('truthfully reports camera-applied sensor-failed partial state', async () => {
    const { handler, ctx, importSensors } = fixture();
    vi.mocked(importSensors.commit).mockRejectedValueOnce(new Error('sensor failure'));
    await apply(handler, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      en.importConfig.partialFailed,
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(callbackData(ctx.reply)).toEqual(['rh:i:t']);
  });

  it('reports an uncertain persisted state when a sensor-only commit rejects', async () => {
    const { handler, ctx, importSensors, importCameraSources } = fixture();
    const states = (handler as unknown as { states: Map<number, unknown> }).states;
    states.set(42, {
      kind: 'awaitingConfirm',
      sensorPlan,
      cameraPlan: { sources: [], configured: [] },
    });
    vi.mocked(importSensors.commit).mockRejectedValueOnce(new Error('reload failed'));
    await apply(handler, ctx);
    expect(importCameraSources.commit).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      en.importConfig.sensorOutcomeUncertain,
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(callbackData(ctx.reply)).toEqual(['rh:i:t']);
  });

  it('stops after the second role check and reports the applied camera phase', async () => {
    const { handler, ctx, importSensors } = fixture(['admin', 'user']);
    await apply(handler, ctx);
    expect(importSensors.commit).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      en.importConfig.partialRoleChanged,
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(callbackData(ctx.reply)).toEqual(['rh:i:t']);
  });

  it('does not report a mutation failure when only the success reply fails', async () => {
    const { handler, ctx, importSensors, importCameraSources } = fixture();
    vi.mocked(ctx.reply).mockRejectedValueOnce(new Error('telegram offline'));
    await expect(apply(handler, ctx)).resolves.toBeUndefined();
    expect(importCameraSources.commit).toHaveBeenCalledOnce();
    expect(importSensors.commit).toHaveBeenCalledOnce();
    expect(ctx.reply).toHaveBeenCalledOnce();
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('Config imported'),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });
});

describe('ImportConfigHandler Return Home state matrix', () => {
  it('keeps Home cancellable from the initial upload prompt', async () => {
    const { handler, ctx, reply } = documentFixture();

    await handler.handleCommand(ctx);

    expect(callbackData(reply)).toEqual(['rh:i:c']);
    expect(JSON.stringify(keyboardRows(reply))).toContain('🏠 Дім');
  });

  it.each([
    ['invalid extension', (ctx: TelegramContext) => {
      (ctx.message as { document: { file_name: string } }).document.file_name = 'config.txt';
    }],
    ['too large', (ctx: TelegramContext) => {
      (ctx.message as { document: { file_size: number } }).document.file_size = 1_000_001;
    }],
    ['parse error', (_ctx: TelegramContext, codec: ConfigCodecPort) => {
      vi.mocked(codec.parse).mockImplementation(() => { throw new Error('bad YAML'); });
    }],
    ['validation error', (_ctx: TelegramContext, codec: ConfigCodecPort) => {
      vi.mocked(codec.parse).mockReturnValue({ sensors: 'invalid' });
    }],
  ])('keeps Home cancellable after %s while awaiting a replacement file', async (_name, configure) => {
    const { handler, codec, ctx, reply } = documentFixture();
    (handler as unknown as { states: Map<number, unknown> }).states.set(42, { kind: 'awaitingFile' });
    configure(ctx, codec);

    await document(handler, ctx);

    expect(callbackData(reply)).toEqual(['rh:i:c']);
    expect((handler as unknown as { states: Map<number, { kind: string }> }).states.get(42)).toEqual({ kind: 'awaitingFile' });
  });

  it('keeps Apply and Cancel together while appending cancellable Home on its own row', async () => {
    const { handler, ctx, reply } = documentFixture();
    (handler as unknown as { states: Map<number, unknown> }).states.set(42, { kind: 'awaitingFile' });

    await document(handler, ctx);

    expect(callbackData(reply)).toEqual(['imp:apply', 'imp:cancel', 'rh:i:c']);
    expect(keyboardRows(reply)[0]).toHaveLength(2);
    expect(keyboardRows(reply).at(-1)).toHaveLength(1);
    expect((handler as unknown as { states: Map<number, { kind: string }> }).states.get(42)?.kind).toBe('awaitingConfirm');
  });

  it.each([
    ['download failure', (ctx: TelegramContext) => vi.mocked(ctx.getFile).mockRejectedValue(new Error('offline'))],
    ['prepare failure', (_ctx: TelegramContext, importSensors: ImportSensorsUseCase) => vi.mocked(importSensors.prepare).mockRejectedValue(new Error('cannot prepare'))],
    ['no changes', (_ctx: TelegramContext, importSensors: ImportSensorsUseCase, importCameraSources: ImportCameraLiveSourcesUseCase) => {
      vi.mocked(importSensors.prepare).mockResolvedValue({ batch: { inserts: [], updates: [], archives: [] }, summary: { added: [], updated: [], archived: [] } });
      vi.mocked(importCameraSources.prepare).mockResolvedValue({ sources: [], configured: [] });
    }],
  ])('clears the import before terminal %s reply', async (_name, configure) => {
    const { handler, importSensors, importCameraSources, ctx, reply } = documentFixture();
    (handler as unknown as { states: Map<number, unknown> }).states.set(42, { kind: 'awaitingFile' });
    configure(ctx, importSensors, importCameraSources);

    await document(handler, ctx);

    expect(callbackData(reply)).toEqual(['rh:i:t']);
    expect((handler as unknown as { states: Map<number, unknown> }).states.has(42)).toBe(false);
  });

  it('uses terminal Home for cancel and interrupted Apply replies', async () => {
    const { handler, ctx, reply } = documentFixture();
    const callback = ctx as unknown as TelegramContext & {
      callbackQuery: { data: string };
      answerCallbackQuery: ReturnType<typeof vi.fn>;
      editMessageReplyMarkup: ReturnType<typeof vi.fn>;
    };
    callback.callbackQuery = { data: 'imp:cancel' };
    callback.answerCallbackQuery = vi.fn().mockResolvedValue(undefined);
    callback.editMessageReplyMarkup = vi.fn().mockResolvedValue(undefined);

    await apply(handler, callback);
    expect(callbackData(reply)).toEqual(['rh:i:t']);

    callback.callbackQuery = { data: 'imp:apply' };
    await apply(handler, callback);
    expect(callbackData(reply)).toEqual(['rh:i:t']);
  });

  it('uses terminal Home after /cancel clears an active import', async () => {
    const { handler, ctx, reply } = documentFixture();
    const commands: Record<
      string,
      (context: TelegramContext) => Promise<void>
    > = {};
    const composer = {
      command: vi.fn((name: string, ...handlers: ((context: TelegramContext) => Promise<void>)[]) => {
        commands[name] = handlers.at(-1)!;
      }),
      callbackQuery: vi.fn(),
      on: vi.fn(),
    };
    handler.register(composer as never);
    (handler as unknown as { states: Map<number, unknown> }).states.set(42, {
      kind: 'awaitingFile',
    });

    await commands.cancel(ctx);

    expect(callbackData(reply)).toEqual(['rh:i:t']);
    expect((handler as unknown as { states: Map<number, unknown> }).states.has(42)).toBe(false);
  });

  it('cancels awaitingFile so the next document listener delegates without downloading or preparing', async () => {
    const { handler, importSensors, importCameraSources, ctx } = documentFixture();
    const listeners: Record<string, (context: TelegramContext, next: () => Promise<void>) => Promise<void>> = {};
    const composer = {
      command: vi.fn(),
      callbackQuery: vi.fn(),
      on: vi.fn((event: string, callback: typeof listeners[string]) => { listeners[event] = callback; }),
    };
    handler.register(composer as never);
    await handler.handleCommand(ctx);
    handler.cancelPending(42);
    const next = vi.fn().mockResolvedValue(undefined);

    await listeners['message:document'](ctx, next);

    expect(next).toHaveBeenCalledOnce();
    expect(ctx.getFile).not.toHaveBeenCalled();
    expect(importSensors.prepare).not.toHaveBeenCalled();
    expect(importCameraSources.prepare).not.toHaveBeenCalled();
  });
});

import { InlineKeyboard } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { en } from '../../../src/locales/en';
import { SystemDepsCheckFailedError } from '../../../src/system/domain/errors/system-deps-check-failed.error';
import type { SystemDepsCheck } from '../../../src/system/domain/ports/system-deps.port';
import type { SystemUpdateUseCase } from '../../../src/telegram/application/system-update.use-case';
import { SystemUpdateHandler } from '../../../src/telegram/interfaces/system-update.handler';
import type { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import type { TelegramContext } from '../../../src/telegram/interfaces/telegram-context';

const updateAvailable: SystemDepsCheck = {
  deps: [{
    name: 'motion',
    current: '4.5.1',
    available: '4.6.0',
    kind: 'upgrade',
  }],
  hasUpdates: true,
  nodeMajorMismatch: false,
};

function callbacks(call: unknown[] | undefined): string[] {
  const markup = (call?.[1] as { reply_markup?: InlineKeyboard } | undefined)?.reply_markup;
  return markup?.inline_keyboard.flat()
    .map((button) => button.callback_data)
    .filter((data): data is string => typeof data === 'string') ?? [];
}

function context(userId = 42, data?: string): TelegramContext {
  return {
    from: { id: userId },
    ...(data ? { callbackQuery: { data } } : {}),
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    localeState: { catalog: en, locale: 'en', user: { role: 'admin' } },
  } as unknown as TelegramContext;
}

function fixture() {
  const systemUpdate = {
    check: vi.fn(),
    apply: vi.fn(),
  } as unknown as SystemUpdateUseCase;
  const handler = new SystemUpdateHandler(
    systemUpdate,
    {} as RoleMiddleware,
  );
  const command = (ctx: TelegramContext) => handler.handleCommand(ctx);
  const applyCallback = (ctx: TelegramContext) => (
    handler as unknown as { onCallback(context: TelegramContext): Promise<void> }
  ).onCallback(ctx);
  return { handler, systemUpdate, command, applyCallback };
}

function seedPending(handler: SystemUpdateHandler, userId: number, check: SystemDepsCheck) {
  (handler as unknown as { pending: Map<number, SystemDepsCheck> }).pending.set(userId, check);
}

describe('SystemUpdateHandler Return Home state matrix', () => {
  it('marks checking and confirmation as cancellable', async () => {
    const { systemUpdate, command } = fixture();
    const ctx = context();
    vi.mocked(systemUpdate.check).mockResolvedValue(updateAvailable);

    await command(ctx);

    expect(callbacks(ctx.reply.mock.calls[0])).toContain('rh:u:c');
    expect(callbacks(ctx.reply.mock.calls.at(-1))).toEqual(
      expect.arrayContaining(['sysupd:apply', 'sysupd:cancel', 'rh:u:c']),
    );
  });

  it('clears a pending confirmation before a Return Home launch', async () => {
    const { handler, systemUpdate, command, applyCallback } = fixture();
    const initial = context();
    const apply = context(42, 'sysupd:apply');
    vi.mocked(systemUpdate.check).mockResolvedValue(updateAvailable);
    await command(initial);

    handler.cancelPending(initial.from!.id);
    await applyCallback(apply);

    expect(systemUpdate.apply).not.toHaveBeenCalled();
    expect(apply.reply).toHaveBeenCalledWith(
      en.common.interrupted,
      expect.objectContaining({ reply_markup: expect.any(InlineKeyboard) }),
    );
    expect(callbacks(apply.reply.mock.calls.at(-1))).toEqual(['rh:u:t']);
  });

  it('marks a spawned update as leave-running', async () => {
    const { handler, systemUpdate, applyCallback } = fixture();
    const ctx = context(42, 'sysupd:apply');
    seedPending(handler, ctx.from!.id, updateAvailable);
    vi.mocked(systemUpdate.apply).mockResolvedValue(undefined);

    await applyCallback(ctx);

    expect(callbacks(ctx.reply.mock.calls.at(-1))).toContain('rh:u:r');
  });

  it('uses terminal Home for no updates and a node-major-only warning', async () => {
    const { systemUpdate, command } = fixture();
    const noUpdates = context();
    vi.mocked(systemUpdate.check).mockResolvedValue({
      deps: [], hasUpdates: false, nodeMajorMismatch: false,
    });
    await command(noUpdates);
    expect(callbacks(noUpdates.reply.mock.calls.at(-1))).toEqual(['rh:u:t']);

    const nodeMajorOnly = context();
    vi.mocked(systemUpdate.check).mockResolvedValue({
      deps: [{ name: 'node', current: '20.0.0', available: '22.x', kind: 'node-major' }],
      hasUpdates: false,
      nodeMajorMismatch: true,
    });
    await command(nodeMajorOnly);
    expect(callbacks(nodeMajorOnly.reply.mock.calls.at(-1))).toEqual(['rh:u:t']);
  });

  it.each([
    ['typed check failure', new SystemDepsCheckFailedError('apt unavailable')],
    ['generic check failure', new Error('offline')],
  ])('uses terminal Home after a %s', async (_name, error) => {
    const { systemUpdate, command } = fixture();
    const ctx = context();
    vi.mocked(systemUpdate.check).mockRejectedValue(error);

    await command(ctx);

    expect(callbacks(ctx.reply.mock.calls.at(-1))).toEqual(['rh:u:t']);
  });

  it('uses terminal Home for explicit cancel, missing pending Apply, and apply failure', async () => {
    const { handler, systemUpdate, applyCallback } = fixture();
    const cancel = context(42, 'sysupd:cancel');
    await applyCallback(cancel);
    expect(callbacks(cancel.reply.mock.calls.at(-1))).toEqual(['rh:u:t']);

    const missing = context(42, 'sysupd:apply');
    await applyCallback(missing);
    expect(callbacks(missing.reply.mock.calls.at(-1))).toEqual(['rh:u:t']);

    const failed = context(42, 'sysupd:apply');
    seedPending(handler, 42, updateAvailable);
    vi.mocked(systemUpdate.apply).mockRejectedValue(new Error('spawn failed'));
    await applyCallback(failed);
    expect(callbacks(failed.reply.mock.calls.at(-1))).toEqual(['rh:u:t']);
  });

  it('cancels pending state only for the specified user', async () => {
    const { handler, systemUpdate, command, applyCallback } = fixture();
    const first = context(42);
    const second = context(99);
    vi.mocked(systemUpdate.check).mockResolvedValue(updateAvailable);
    await command(first);
    await command(second);

    handler.cancelPending(42);
    await applyCallback(context(42, 'sysupd:apply'));
    await applyCallback(context(99, 'sysupd:apply'));

    expect(systemUpdate.apply).toHaveBeenCalledOnce();
  });
});

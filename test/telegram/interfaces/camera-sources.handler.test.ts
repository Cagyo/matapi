import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';
import { CameraSourcesHandler } from '../../../src/telegram/interfaces/camera-sources.handler';
import type { WorkflowEntryCoordinator } from '../../../src/telegram/interfaces/workflow-entry.coordinator';
import type { WorkflowNavigationHandler } from '../../../src/telegram/interfaces/workflow-navigation.handler';

const receipt = {
  id: 'abcdefghijklmnop',
  userId: 100,
  chatId: 42,
  kind: 'workflow-return',
  sessionToken: null,
  status: 'pending',
  expiresAt: new Date('2030-01-01'),
  payload: {
    workflow: 'camera',
    phase: 'cancellable',
    originSource: 'captured',
    origin: { kind: 'sensors', page: 1 },
  },
} satisfies WorkflowReturnReceipt;
const source = {
  cameraId: 'camera-with-private-id',
  cameraName: 'Front door',
  summary: {
    scheme: 'rtsp' as const,
    host: 'camera.local:554',
    transport: 'tcp' as const,
    tlsMode: 'none' as const,
    profile: 'eco' as const,
    substreamHost: null,
    ready: true,
  },
};

function setup() {
  const configure = { execute: vi.fn().mockResolvedValue(source) };
  const list = { execute: vi.fn().mockResolvedValue([source]) };
  const remove = { execute: vi.fn().mockResolvedValue(undefined) };
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
  const handler = new CameraSourcesHandler(
    configure as never,
    list as never,
    remove as never,
    { now: () => new Date('2026-07-17') },
    workflows as unknown as WorkflowEntryCoordinator,
    navigation as unknown as WorkflowNavigationHandler,
  );
  return { configure, handler, list, navigation, remove, workflows };
}

function context(input: { text?: string; role?: 'admin' | 'user'; messageId?: number } = {}) {
  return {
    from: { id: 100 },
    chat: { id: 42, type: 'private' },
    message: input.text === undefined ? undefined : { message_id: input.messageId ?? 71, text: input.text },
    localeState: {
      locale: 'en',
      catalog: catalogFor('en'),
      user: { telegramId: 100, role: input.role ?? 'admin' },
    },
    reply: vi.fn().mockResolvedValue({ message_id: 9 }),
    api: { deleteMessage: vi.fn().mockResolvedValue(true) },
  };
}

function keyboardData(ctx: ReturnType<typeof context>): string[] {
  return (ctx.reply.mock.calls as unknown[][]).flatMap((call) => callbackData(call[1]));
}

function callbackData(options: unknown): string[] {
  if (!isRecord(options) || !isRecord(options.reply_markup) || !Array.isArray(options.reply_markup.inline_keyboard))
    return [];
  return options.reply_markup.inline_keyboard.flatMap((row) =>
    Array.isArray(row)
      ? row.flatMap((button) =>
          isRecord(button) && typeof button.callback_data === 'string' ? [button.callback_data] : [],
        )
      : [],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

describe('CameraSourcesHandler contextual state', () => {
  it('renders only receipt-bound source callbacks without camera ids or credentials', async () => {
    const { handler } = setup();
    const ctx = context();
    await handler.handleEntry(ctx as never, { receipt });
    const data = keyboardData(ctx);

    expect(data).toEqual(expect.arrayContaining(['cam:abcdefghijklmnop:src:a', 'cam:abcdefghijklmnop:src:e']));
    expect(data.every((value) => Buffer.byteLength(value, 'utf8') <= 64)).toBe(true);
    expect(JSON.stringify(data)).not.toContain('camera-with-private-id');
  });

  it('does not consume a stale credential prompt or delete its message', async () => {
    const { configure, handler, workflows } = setup();
    await handler.handleCallback(context() as never, 'a', receipt);
    workflows.validateCurrent.mockResolvedValueOnce(false);
    const credential = context({ text: 'rtsp://user:pass@camera.local/live' });

    await expect(handler.handleText(credential as never)).resolves.toBe(false);

    expect(configure.execute).not.toHaveBeenCalled();
    expect(credential.api.deleteMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(credential.reply.mock.calls)).not.toContain('user:pass');
  });

  it('keys selection by receipt and resolves only opaque source selectors', async () => {
    const { handler } = setup();
    const ctx = context();
    await handler.handleCallback(ctx as never, 'e', receipt);
    const choices = keyboardData(ctx);

    expect(choices.some((value) => /^cam:abcdefghijklmnop:src:s:[A-Za-z0-9_-]{12}$/.test(value))).toBe(true);
    expect(JSON.stringify(choices)).not.toContain('camera-with-private-id');
  });

  it('marks configuration running before using and deleting the credential text', async () => {
    const { configure, handler, workflows } = setup();
    await handler.handleCallback(context() as never, 'a', receipt);
    await handler.handleText(context({ text: 'Front door' }) as never);
    const credential = context({
      text: 'rtsps://user:pass@camera.local/live',
      messageId: 88,
    });

    await handler.handleText(credential as never);

    expect(workflows.markRunning).toHaveBeenCalledWith(credential, receipt);
    expect(configure.execute).toHaveBeenCalledWith(
      expect.objectContaining({ cameraName: 'Front door', tlsMode: 'strict' }),
    );
    expect(credential.api.deleteMessage).toHaveBeenCalledWith(42, 88);
    expect(JSON.stringify(credential.reply.mock.calls)).not.toContain('user:pass');
  });
});

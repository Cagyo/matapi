import { describe, expect, it, vi } from 'vitest';
import type { ConfigureLiveSourceUseCase } from '../../../src/camera/application/configure-live-source.use-case';
import type { ListLiveSourcesUseCase } from '../../../src/camera/application/list-live-sources.use-case';
import type { RemoveLiveSourceUseCase } from '../../../src/camera/application/remove-live-source.use-case';
import { en } from '../../../src/locales/en';
import { CameraSourcesHandler } from '../../../src/telegram/interfaces/camera-sources.handler';
import type { TelegramContext } from '../../../src/telegram/interfaces/telegram-context';

const source = {
  cameraId: 'cam-1',
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

function setup(now = () => 1_000) {
  const configure = { execute: vi.fn().mockResolvedValue(source) };
  const list = { execute: vi.fn().mockResolvedValue([source]) };
  const remove = { execute: vi.fn().mockResolvedValue(undefined) };
  const handler = new CameraSourcesHandler(
    configure as unknown as ConfigureLiveSourceUseCase,
    list as unknown as ListLiveSourcesUseCase,
    remove as unknown as RemoveLiveSourceUseCase,
    { now: () => new Date(now()) },
  );
  return { handler, configure, list, remove };
}

function context(input: {
  role?: 'admin' | 'user';
  text?: string;
  messageId?: number;
  userId?: number;
  chatId?: number;
} = {}) {
  return {
    from: { id: input.userId ?? 100 },
    chat: { id: input.chatId ?? 42, type: 'private' },
    message: input.text === undefined
      ? undefined
      : { message_id: input.messageId ?? 17, text: input.text },
    localeState: {
      user: { telegramId: input.userId ?? 100, name: 'admin', role: input.role ?? 'admin' },
      locale: 'en',
      catalog: en,
    },
    reply: vi.fn().mockResolvedValue({ message_id: 9 }),
    api: { deleteMessage: vi.fn().mockResolvedValue(true) },
  } as unknown as TelegramContext & {
    reply: ReturnType<typeof vi.fn>;
    api: { deleteMessage: ReturnType<typeof vi.fn> };
  };
}

describe('CameraSourcesHandler', () => {
  it('is admin-only at entry', async () => {
    const { handler } = setup();
    const ctx = context({ role: 'user' });

    await handler.handleEntry(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(en.common.adminRequired);
    expect(ctx.reply).not.toHaveBeenCalledWith(en.camera.sources.menuTitle, expect.anything());
  });

  it('adds a source and deletes the exact credential message', async () => {
    const { handler, configure } = setup();
    const prompt = context();
    await handler.handleCallback(prompt, 'add');
    await handler.handleText(context({ text: 'Front door' }));
    const credential = context({ text: 'rtsp://user:pass@camera.local/live', messageId: 77 });

    await handler.handleText(credential);

    expect(configure.execute).toHaveBeenCalledWith({
      cameraName: 'Front door',
      url: 'rtsp://user:pass@camera.local/live',
      transport: 'tcp',
      tlsMode: 'none',
      profile: 'eco',
    });
    expect(credential.api.deleteMessage).toHaveBeenCalledWith(42, 77);
    expect(JSON.stringify(credential.reply.mock.calls)).not.toContain('user:pass');
  });

  it('deletes credential text in finally when configuration fails', async () => {
    const { handler, configure } = setup();
    configure.execute.mockRejectedValueOnce(new Error('rtsp://user:pass@secret/path'));
    await handler.handleCallback(context(), 'add');
    await handler.handleText(context({ text: 'Front door' }));
    const credential = context({ text: 'rtsp://user:pass@secret/path', messageId: 88 });

    await handler.handleText(credential);

    expect(credential.api.deleteMessage).toHaveBeenCalledWith(42, 88);
    expect(JSON.stringify(credential.reply.mock.calls)).not.toContain('user:pass');
    expect(credential.reply).toHaveBeenCalledWith(en.camera.sources.configureFailed);
  });

  it('reports deletion failure with localized secret-free text', async () => {
    const { handler } = setup();
    await handler.handleCallback(context(), 'add');
    await handler.handleText(context({ text: 'Front door' }));
    const credential = context({ text: 'rtsp://user:pass@secret/path' });
    credential.api.deleteMessage.mockRejectedValueOnce(new Error('forbidden user:pass'));

    await handler.handleText(credential);

    expect(credential.reply).toHaveBeenCalledWith(en.camera.sources.deletionFailed);
    expect(JSON.stringify(credential.reply.mock.calls)).not.toContain('user:pass');
  });

  it('deletes credential text before awaiting an outcome reply', async () => {
    const { handler } = setup();
    await handler.handleCallback(context(), 'add');
    await handler.handleText(context({ text: 'Front door' }));
    const credential = context({ text: 'rtsp://user:pass@secret/path', messageId: 91 });
    let releaseReply!: () => void;
    credential.reply.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseReply = resolve;
    }));

    const handling = handler.handleText(credential);
    await vi.waitFor(() => {
      expect(credential.api.deleteMessage).toHaveBeenCalledWith(42, 91);
    });
    releaseReply();
    await handling;
  });

  it('clears state when the current role is downgraded', async () => {
    const { handler, configure } = setup();
    await handler.handleCallback(context(), 'add');
    const downgraded = context({ role: 'user', text: 'Front door' });

    await handler.handleText(downgraded);
    const later = await handler.handleText(context({ text: 'rtsp://camera.local/live' }));

    expect(downgraded.reply).toHaveBeenCalledWith(en.common.adminRequired);
    expect(later).toBe(false);
    expect(configure.execute).not.toHaveBeenCalled();
  });

  it('expires bounded state and clears it', async () => {
    let now = 1_000;
    const { handler } = setup(() => now);
    await handler.handleCallback(context(), 'add');
    now += 10 * 60_000 + 1;
    const expired = context({ text: 'Front door' });

    expect(await handler.handleText(expired)).toBe(true);
    expect(expired.reply).toHaveBeenCalledWith(en.camera.sources.expired);
    expect(await handler.handleText(context({ text: 'Front door' }))).toBe(false);
  });

  it('lists only redacted source fields', async () => {
    const { handler } = setup();
    const ctx = context();

    await handler.handleCallback(ctx, 'list');

    const output = String(ctx.reply.mock.calls.at(-1)?.[0]);
    expect(output).toContain('Front door');
    expect(output).toContain('camera.local:554');
    expect(output).not.toContain('rtsp://');
    expect(output).not.toContain('password');
  });

  it.each(['edit', 'test'] as const)('selects a fresh exact source for %s', async (action) => {
    const { handler, list, configure } = setup();
    await handler.handleCallback(context(), action);
    list.execute.mockResolvedValueOnce([source]);
    await handler.handleCallback(context(), `${action}:cam-1`);
    const credential = context({ text: 'rtsps://camera.local/live' });

    await handler.handleText(credential);

    expect(list.execute).toHaveBeenCalledTimes(2);
    expect(configure.execute).toHaveBeenCalledWith(expect.objectContaining({
      cameraName: 'Front door',
      tlsMode: 'strict',
    }));
  });

  it('rejects an invalid or stale callback selection', async () => {
    const { handler, list, configure } = setup();
    await handler.handleCallback(context(), 'edit');
    list.execute.mockResolvedValueOnce([]);
    const ctx = context();

    await handler.handleCallback(ctx, 'edit:cam-1');

    expect(ctx.reply).toHaveBeenCalledWith(en.camera.sources.staleSelection);
    expect(configure.execute).not.toHaveBeenCalled();
  });

  it('removes the exact source selected from a fresh redacted list', async () => {
    const { handler, list, remove } = setup();
    await handler.handleCallback(context(), 'remove');
    list.execute.mockResolvedValueOnce([source]);
    const ctx = context();

    await handler.handleCallback(ctx, 'remove:cam-1');

    expect(list.execute).toHaveBeenCalledTimes(2);
    expect(remove.execute).toHaveBeenCalledWith('cam-1');
    expect(ctx.reply).toHaveBeenCalledWith(en.camera.sources.removed('Front door'));
  });

  it('cancels and clears the current state', async () => {
    const { handler } = setup();
    await handler.handleCallback(context(), 'add');
    const cancelled = context();
    await handler.handleCallback(cancelled, 'cancel');

    expect(cancelled.reply).toHaveBeenCalledWith(en.camera.sources.cancelled);
    expect(await handler.handleText(context({ text: 'Front door' }))).toBe(false);
  });

  it('clears state when a conversation reply fails', async () => {
    const { handler, configure } = setup();
    await handler.handleCallback(context(), 'add');
    const cameraName = context({ text: 'Front door' });
    cameraName.reply.mockRejectedValueOnce(new Error('Telegram unavailable'));

    await expect(handler.handleText(cameraName)).rejects.toThrow('Telegram unavailable');

    expect(await handler.handleText(context({ text: 'rtsp://camera.local/live' }))).toBe(false);
    expect(configure.execute).not.toHaveBeenCalled();
  });

  it('isolates state by both admin and chat', async () => {
    const { handler } = setup();
    await handler.handleCallback(context({ userId: 100, chatId: 42 }), 'add');

    expect(await handler.handleText(context({ userId: 101, chatId: 42, text: 'Front door' }))).toBe(false);
    expect(await handler.handleText(context({ userId: 100, chatId: 43, text: 'Front door' }))).toBe(false);
  });

  it('cancels only the exact source-management state without use cases', async () => {
    const { handler, configure, list, remove } = setup();
    await handler.handleCallback(context({ userId: 100, chatId: 42 }), 'add');
    await handler.handleCallback(context({ userId: 101, chatId: 42 }), 'add');
    await handler.handleCallback(context({ userId: 100, chatId: 43 }), 'add');

    handler.cancelPending(100, 42);

    expect(handler.hasPending(100, 42)).toBe(false);
    expect(handler.hasPending(101, 42)).toBe(true);
    expect(handler.hasPending(100, 43)).toBe(true);
    expect(configure.execute).not.toHaveBeenCalled();
    expect(list.execute).not.toHaveBeenCalled();
    expect(remove.execute).not.toHaveBeenCalled();
  });

  it('expires stale source-management state through its injected clock', async () => {
    let now = 1_000;
    const { handler } = setup(() => now);
    await handler.handleCallback(context(), 'add');
    now += 10 * 60_000 + 1;

    expect(handler.hasPending(100, 42)).toBe(false);
    expect(handler.hasPending(100, 42)).toBe(false);
  });
});

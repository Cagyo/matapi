import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateGdriveAuthUseCase } from '../../../src/camera/application/update-gdrive-auth.use-case';
import { GdriveAuthFailedError } from '../../../src/camera/domain/errors/gdrive-auth-failed.error';
import { GdriveNotInstalledError } from '../../../src/camera/domain/errors/gdrive-not-installed.error';
import { catalogFor } from '../../../src/locales';
import { GdriveAuthHandler } from '../../../src/telegram/interfaces/gdrive-auth.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';

function localeState(role: 'admin' | 'user') {
  return {
    user: {
      telegramId: 12345,
      name: 'Admin',
      role,
      locale: 'en' as const,
      muted: false,
      quietStart: null,
      quietEnd: null,
      createdAt: null,
    },
    locale: 'en' as const,
    catalog: catalogFor('en'),
  };
}

function createTestSetup() {
  const updateUseCase = {
    execute: vi.fn(async () => ({
      totalBytes: 15 * 1024 ** 3,
      usedBytes: 8 * 1024 ** 3,
      freeBytes: 7 * 1024 ** 3,
    })),
  } as unknown as UpdateGdriveAuthUseCase;

  const guard = {
    adminOnly: vi.fn(),
  } as unknown as RoleMiddleware;

  const handler = new GdriveAuthHandler(updateUseCase, guard);

  const commandCallbacks: Record<string, (...args: any[]) => any> = {};
  const onCallbacks: Record<string, (...args: any[]) => any> = {};
  const composer = {
    command: vi.fn((cmd, middleware, fn) => {
      commandCallbacks[cmd] = fn || middleware;
    }),
    callbackQuery: vi.fn(),
    on: vi.fn((event, middleware, fn) => {
      onCallbacks[event] = fn || middleware;
    }),
  } as any;

  handler.register(composer);

  return {
    handler,
    updateUseCase,
    guard,
    composer,
    commandCallbacks,
    onCallbacks,
  };
}

interface ReplySpy {
  mock: {
    calls: [
      unknown,
      { reply_markup?: { inline_keyboard?: { callback_data?: string }[][] } }?,
    ][];
  };
}

type MessageListener = (context: object, next: () => Promise<unknown>) => Promise<void>;
type MessageListeners = Record<'message:text' | 'message:document', MessageListener>;

function callbacks(reply: ReplySpy): string[] {
  return reply.mock.calls.flatMap(([, options]) =>
    options?.reply_markup?.inline_keyboard?.flat()
      .map((button) => button.callback_data)
      .filter((data: string | undefined): data is string => typeof data === 'string') ?? [],
  );
}

function awaitingConfig(handler: GdriveAuthHandler, userId = 12345): boolean {
  return (handler as unknown as { states: Map<number, unknown> }).states.has(userId);
}

describe('GdriveAuthHandler', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('registers commands and listeners', () => {
    const { composer } = createTestSetup();
    expect(composer.command).toHaveBeenCalledWith('gdrive_auth', expect.anything(), expect.anything());
    expect(composer.command).toHaveBeenCalledWith('cancel', expect.anything(), expect.anything());
    expect(composer.callbackQuery).toHaveBeenCalledWith('gdauth:start', expect.anything(), expect.anything());
    expect(composer.on).toHaveBeenCalledWith('message:text', expect.anything());
    expect(composer.on).toHaveBeenCalledWith('message:document', expect.anything());
  });

  it('starts wizard and replies with prompt', async () => {
    const { commandCallbacks } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = { reply, from: { id: 12345 } };

    await commandCallbacks.gdrive_auth(ctx);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0]).toContain('Google Drive Auth Setup');
  });

  it('includes the resolved local SSH host in the prompt', async () => {
    vi.stubEnv('HOME_WORKER_SSH_HOST', '192.168.1.42');
    const { commandCallbacks } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = { reply, from: { id: 12345 } };

    await commandCallbacks.gdrive_auth(ctx);

    expect(reply.mock.calls[0][0]).toContain('ssh pi@192.168.1.42');
    expect(reply.mock.calls[0][0]).not.toContain('<pi-host>');
  });

  it('rejects text without [gdrive] header when in awaitingConfig state', async () => {
    const { commandCallbacks, onCallbacks } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);
    const next = vi.fn().mockResolvedValue(true);
    const ctx = {
      reply,
      from: { id: 12345 },
      localeState: localeState('admin'),
      message: { text: 'some invalid config without header' },
    };

    await commandCallbacks.gdrive_auth(ctx);
    await onCallbacks['message:text'](ctx, next);

    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply.mock.calls[1][0]).toContain("doesn't look like an rclone config section");
    expect(next).not.toHaveBeenCalled();
  });

  it('executes usecase when valid [gdrive] snippet is provided', async () => {
    const { commandCallbacks, onCallbacks, updateUseCase } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);
    const next = vi.fn().mockResolvedValue(true);
    const ctx = {
      reply,
      from: { id: 12345 },
      localeState: localeState('admin'),
      message: { text: '[gdrive]\ntype = drive\nscope = drive' },
    };

    await commandCallbacks.gdrive_auth(ctx);
    await onCallbacks['message:text'](ctx, next);

    expect(updateUseCase.execute).toHaveBeenCalledWith('[gdrive]\ntype = drive\nscope = drive');
    expect(reply.mock.calls[1][0]).toContain('Google Drive connected!');
  });

  it('clears a demoted sender state before processing a text snippet', async () => {
    const { commandCallbacks, onCallbacks, updateUseCase } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      from: { id: 12345 },
      localeState: localeState('user'),
      reply,
      message: { text: '[gdrive]\ntype = drive' },
    };

    await commandCallbacks.gdrive_auth(ctx);
    await onCallbacks['message:text'](ctx, vi.fn());

    expect(updateUseCase.execute).not.toHaveBeenCalled();
    expect(reply).toHaveBeenLastCalledWith(
      catalogFor('en').common.adminRequired,
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });

  it('clears a demoted sender state before downloading a document snippet', async () => {
    const { commandCallbacks, onCallbacks, updateUseCase } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(undefined);
    const getFile = vi.fn();
    const ctx = {
      from: { id: 12345 },
      localeState: localeState('user'),
      reply,
      getFile,
      message: { document: { file_name: 'rclone.conf' } },
    };

    await commandCallbacks.gdrive_auth(ctx);
    await onCallbacks['message:document'](ctx, vi.fn());

    expect(getFile).not.toHaveBeenCalled();
    expect(updateUseCase.execute).not.toHaveBeenCalled();
    expect(reply).toHaveBeenLastCalledWith(
      catalogFor('en').common.adminRequired,
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });

  it('keeps Return Home cancellable from initial and repeated auth prompts', async () => {
    const { handler, commandCallbacks } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = { reply, from: { id: 12345 } };

    await commandCallbacks.gdrive_auth(ctx);
    await commandCallbacks.gdrive_auth(ctx);

    expect(callbacks(reply)).toEqual(['rh:d:c', 'rh:d:c']);
    expect(awaitingConfig(handler)).toBe(true);
  });

  it('keeps Return Home cancellable after invalid text while awaiting a valid config', async () => {
    const { handler, commandCallbacks, onCallbacks } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = {
      reply,
      from: { id: 12345 },
      localeState: localeState('admin'),
      message: { text: 'not a config', document: { file_name: 'rclone.pdf' } },
    };

    await commandCallbacks.gdrive_auth(ctx);
    await (onCallbacks as unknown as MessageListeners)['message:text'](ctx, async () => undefined);

    expect(callbacks(reply).at(-1)).toBe('rh:d:c');
    expect(awaitingConfig(handler)).toBe(true);
  });

  it('keeps Return Home cancellable after invalid file while awaiting a valid config', async () => {
    const { handler, commandCallbacks, onCallbacks } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = {
      reply,
      from: { id: 12345 },
      localeState: localeState('admin'),
      message: { document: { file_name: 'rclone.pdf' } },
    };

    await commandCallbacks.gdrive_auth(ctx);
    await (onCallbacks as unknown as MessageListeners)['message:document'](ctx, async () => undefined);

    expect(callbacks(reply).at(-1)).toBe('rh:d:c');
    expect(awaitingConfig(handler)).toBe(true);
  });

  it('keeps Return Home cancellable after a document download failure', async () => {
    const { handler, commandCallbacks, onCallbacks } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = {
      reply,
      from: { id: 12345 },
      localeState: localeState('admin'),
      getFile: vi.fn().mockRejectedValue(new Error('offline')),
      message: { document: { file_name: 'rclone.conf' } },
    };

    await commandCallbacks.gdrive_auth(ctx);
    await onCallbacks['message:document'](ctx, vi.fn());

    expect(callbacks(reply).at(-1)).toBe('rh:d:c');
    expect(awaitingConfig(handler)).toBe(true);
  });

  it('keeps Return Home cancellable after a generic auth update failure', async () => {
    const { handler, commandCallbacks, onCallbacks, updateUseCase } = createTestSetup();
    vi.mocked(updateUseCase.execute).mockRejectedValueOnce(new Error('offline'));
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = {
      reply,
      from: { id: 12345 },
      localeState: localeState('admin'),
      message: { text: '[gdrive]\ntype = drive' },
    };

    await commandCallbacks.gdrive_auth(ctx);
    await onCallbacks['message:text'](ctx, vi.fn());

    expect(callbacks(reply).at(-1)).toBe('rh:d:c');
    expect(awaitingConfig(handler)).toBe(true);
  });

  it.each([
    ['success', undefined],
    ['not installed', new GdriveNotInstalledError()],
    ['typed auth failure', new GdriveAuthFailedError('expired')],
  ])('clears the auth state before terminal Return Home after %s', async (_name, error) => {
    const { handler, commandCallbacks, onCallbacks, updateUseCase } = createTestSetup();
    if (error) vi.mocked(updateUseCase.execute).mockRejectedValueOnce(error);
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = {
      reply,
      from: { id: 12345 },
      localeState: localeState('admin'),
      message: { text: '[gdrive]\ntype = drive' },
    };

    await commandCallbacks.gdrive_auth(ctx);
    await onCallbacks['message:text'](ctx, vi.fn());

    expect(callbacks(reply).at(-1)).toBe('rh:d:t');
    expect(awaitingConfig(handler)).toBe(false);
  });

  it('clears a demoted sender before its terminal Return Home reply', async () => {
    const { handler, commandCallbacks, onCallbacks } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = {
      reply,
      from: { id: 12345 },
      localeState: localeState('user'),
      message: { text: '[gdrive]\ntype = drive' },
    };

    await commandCallbacks.gdrive_auth(ctx);
    await onCallbacks['message:text'](ctx, vi.fn());

    expect(callbacks(reply).at(-1)).toBe('rh:d:t');
    expect(awaitingConfig(handler)).toBe(false);
  });

  it('never serializes Drive credentials, filenames, or snippets into auth keyboards', async () => {
    const { commandCallbacks, onCallbacks } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);
    const snippet = '[gdrive]\ntoken = secret-token-value';
    const fileName = 'private-rclone.conf';
    const ctx = {
      reply,
      from: { id: 12345 },
      localeState: localeState('admin'),
      message: { text: snippet, document: { file_name: fileName } },
    };

    await commandCallbacks.gdrive_auth(ctx);
    await onCallbacks['message:text'](ctx, vi.fn());

    const serializedKeyboard = callbacks(reply).join('|');
    expect(serializedKeyboard).not.toContain('[gdrive]');
    expect(serializedKeyboard).not.toContain('secret-token-value');
    expect(serializedKeyboard).not.toContain(fileName);
    expect(callbacks(reply)).toEqual(expect.arrayContaining(['rh:d:c', 'rh:d:t']));
  });

  it('cancels only the caller in-memory awaiting config state', async () => {
    const { handler, commandCallbacks } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);

    await commandCallbacks.gdrive_auth({ reply, from: { id: 12345 } });
    await commandCallbacks.gdrive_auth({ reply, from: { id: 67890 } });
    handler.cancelPending(12345);

    expect(awaitingConfig(handler, 12345)).toBe(false);
    expect(awaitingConfig(handler, 67890)).toBe(true);
  });
});

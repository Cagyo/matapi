import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateGdriveAuthUseCase } from '../../../src/camera/application/update-gdrive-auth.use-case';
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

describe('GdriveAuthHandler', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
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
    expect(reply).toHaveBeenLastCalledWith(catalogFor('en').common.adminRequired);
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
    expect(reply).toHaveBeenLastCalledWith(catalogFor('en').common.adminRequired);
  });
});

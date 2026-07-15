import { describe, expect, it, vi } from 'vitest';
import { GdriveStatusUseCase } from '../../../src/camera/application/gdrive-status.use-case';
import { GdriveNotConfiguredError } from '../../../src/camera/domain/errors/gdrive-not-configured.error';
import { GdriveNotInstalledError } from '../../../src/camera/domain/errors/gdrive-not-installed.error';
import { GdriveStatusFailedError } from '../../../src/camera/domain/errors/gdrive-status-failed.error';
import { GdriveHandler } from '../../../src/telegram/interfaces/gdrive.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';

interface ReplySpy {
  mock: {
    calls: [
      unknown,
      { reply_markup?: { inline_keyboard?: { callback_data?: string }[][] } }?,
    ][];
  };
}

function callbacks(reply: ReplySpy): string[] {
  return reply.mock.calls.flatMap(([, options]) =>
    options?.reply_markup?.inline_keyboard?.flat()
      .map((button) => button.callback_data)
      .filter((data: string | undefined): data is string => typeof data === 'string') ?? [],
  );
}

function createTestSetup() {
  const statusUseCase = {
    execute: vi.fn(async () => ({
      quota: { usedBytes: 5000000000, totalBytes: 15000000000 },
      lastUploadAt: new Date('2026-07-07T12:00:00Z'),
      pendingUploads: 2,
      failedUploads: 0,
      lastError: null,
      cleanupMinAgeDays: 30,
    })),
  } as unknown as GdriveStatusUseCase;

  const guard = {
    adminOnly: vi.fn(),
  } as unknown as RoleMiddleware;

  const handler = new GdriveHandler(statusUseCase, guard);

  const commandCallbacks: Record<string, (...args: any[]) => any> = {};
  const composer = {
    command: vi.fn((cmd, middleware, fn) => {
      commandCallbacks[cmd] = fn || middleware;
    }),
  } as any;

  handler.register(composer);

  return {
    handler,
    statusUseCase,
    guard,
    composer,
    commandCallbacks,
  };
}

describe('GdriveHandler', () => {
  it('registers /gdrive command', () => {
    const { composer } = createTestSetup();
    expect(composer.command).toHaveBeenCalledWith('gdrive', expect.anything(), expect.anything());
  });

  it('replies with status and clean trigger button on /gdrive status', async () => {
    const { commandCallbacks } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);
    const ctx = { reply, match: 'status' };

    await commandCallbacks.gdrive(ctx);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0]).toContain('Google Drive Status');
    expect(reply.mock.calls[0][1]).toHaveProperty('reply_markup');
  });

  it('preserves status actions while appending terminal Return Home', async () => {
    const { handler } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);
    const canonicalReply = vi.fn().mockResolvedValue(true);

    await handler.handleStatus({ reply } as never);
    await handler.handleStatus({ reply: canonicalReply } as never, {
      includeCleanupAction: false,
    });

    expect(callbacks(reply)).toEqual(
      expect.arrayContaining(['clean:trigger', 'gdauth:start', 'rh:d:t']),
    );
    expect(callbacks(canonicalReply)).toEqual(
      expect.arrayContaining(['gdauth:start', 'rh:d:t']),
    );
    expect(callbacks(canonicalReply)).not.toContain('clean:trigger');
  });

  it.each([
    ['not installed', new GdriveNotInstalledError()],
    ['not configured', new GdriveNotConfiguredError()],
    ['status failed', new GdriveStatusFailedError('offline')],
    ['generic failure', new Error('offline')],
  ])('adds terminal Return Home for %s errors', async (_name, error) => {
    const { handler, statusUseCase } = createTestSetup();
    vi.mocked(statusUseCase.execute).mockRejectedValueOnce(error);
    const reply = vi.fn().mockResolvedValue(true);

    await handler.handleStatus({ reply } as never);

    expect(callbacks(reply)).toEqual(['rh:d:t']);
  });

  it('adds terminal Return Home for invalid /gdrive usage', async () => {
    const { commandCallbacks } = createTestSetup();
    const reply = vi.fn().mockResolvedValue(true);

    await commandCallbacks.gdrive({ reply, match: 'unexpected' });

    expect(callbacks(reply)).toEqual(['rh:d:t']);
  });
});

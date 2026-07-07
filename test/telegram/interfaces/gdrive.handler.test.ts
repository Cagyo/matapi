import { describe, expect, it, vi } from 'vitest';
import { GdriveStatusUseCase } from '../../../src/camera/application/gdrive-status.use-case';
import { GdriveHandler } from '../../../src/telegram/interfaces/gdrive.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';

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
});

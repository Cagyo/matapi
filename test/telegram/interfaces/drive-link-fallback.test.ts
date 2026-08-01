import { describe, expect, it, vi } from 'vitest';
import { CameraHandler } from '../../../src/telegram/interfaces/camera.handler';
import type { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import type { CameraSourcesHandler } from '../../../src/telegram/interfaces/camera-sources.handler';
import type { WorkflowEntryCoordinator } from '../../../src/telegram/interfaces/workflow-entry.coordinator';
import type { WorkflowNavigationHandler } from '../../../src/telegram/interfaces/workflow-navigation.handler';
import { en } from '../../../src/locales/en';

describe('Camera Drive link fallback', () => {
  it('sends only the current verified private webViewLink to an admin', async () => {
    const fixture = setup('admin');

    await fixture.camera(fixture.ctx);

    expect(fixture.ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining('https://drive.example/current-private-link'),
      {},
    );
    expect(fixture.ctx.reply).not.toHaveBeenCalledWith(
      expect.stringContaining('legacy-stale-path'),
      expect.anything(),
    );
  });

  it('does not disclose a private Drive link to a non-admin', async () => {
    const fixture = setup('user');

    await fixture.camera(fixture.ctx);

    expect(fixture.ctx.reply).toHaveBeenCalledWith(en.common.adminRequired);
    expect(fixture.ctx.reply.mock.calls.flat().join(' ')).not.toContain(
      'https://drive.example/current-private-link',
    );
  });
});

describe('en.camera.driveLinkFallback', () => {
  it('shows the supplied exact private link without fabricating another URL', () => {
    const text = en.camera.driveLinkFallback(7, 'https://drive.example/current-private-link');

    expect(text).toContain('https://drive.example/current-private-link');
    expect(text).not.toContain('drive.google.com');
  });

  it('explains when no Drive copy exists yet', () => {
    expect(en.camera.driveLinkFallback(7, null).toLowerCase()).toContain('no drive copy');
  });
});

function setup(role: 'admin' | 'user') {
  const receipt = {
    id: 'abcdefghijklmnop',
    userId: 7,
    chatId: 11,
    kind: 'workflow-return',
    sessionToken: 'home-token',
    status: 'pending',
    expiresAt: new Date('2030-01-01'),
    payload: {
      workflow: 'camera',
      phase: 'cancellable',
      originSource: 'natural-parent',
      origin: { kind: 'home' },
    },
  };
  const event = {
    id: 7,
    cameraId: 'front',
    startedAt: new Date('2026-07-17T12:00:00Z'),
    endedAt: new Date('2026-07-17T12:01:00Z'),
    videoPath: '/motion/7.mp4',
    snapshotPath: null,
    archiveArtifactId: 'artifact-7',
    archiveWebViewLink: 'https://drive.example/current-private-link',
    uploadedToGdrive: true,
    gdriveFileId: 'legacy-stale-path',
    localDeleted: true,
  };
  const workflows = {
    begin: vi.fn().mockResolvedValue(receipt),
    validateCurrent: vi.fn().mockResolvedValue(true),
    markRunning: vi.fn().mockResolvedValue(true),
  };
  const navigation = {
    complete: vi.fn(async (
      _ctx: unknown,
      _launch: unknown,
      presentation: { deliver(): Promise<void> },
    ) => { await presentation.deliver(); }),
  };
  const handler = new CameraHandler(
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { latest: vi.fn(), between: vi.fn() } as never,
    {
      execute: vi.fn().mockResolvedValue({
        kind: 'drive',
        event,
        webViewLink: 'https://drive.example/current-private-link',
      }),
    } as never,
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { execute: vi.fn() } as never,
    { revokeUser: vi.fn() } as never,
    { registered: vi.fn() } as unknown as RoleMiddleware,
    { cancelPending: vi.fn() } as unknown as CameraSourcesHandler,
    workflows as unknown as WorkflowEntryCoordinator,
    { register: vi.fn() } as never,
    navigation as unknown as WorkflowNavigationHandler,
  );
  let camera!: (ctx: typeof ctx) => Promise<void>;
  handler.register({
    command: vi.fn((_name, _guard, callback) => { camera = callback; }),
    callbackQuery: vi.fn(),
    on: vi.fn(),
  } as never);
  const ctx = {
    from: { id: 7 },
    chat: { id: 11, type: 'private' },
    match: 'video 7',
    message: { message_id: 20, text: '/camera video 7' },
    localeState: { user: { telegramId: 7, role } },
    reply: vi.fn().mockResolvedValue({ message_id: 55 }),
    replyWithChatAction: vi.fn(),
    replyWithVideo: vi.fn(),
  };
  return { camera, ctx };
}

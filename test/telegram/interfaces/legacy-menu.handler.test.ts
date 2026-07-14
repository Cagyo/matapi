import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { LegacyMenuHandler } from '../../../src/telegram/interfaces/legacy-menu.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';

function state(role: 'admin' | 'user' = 'user', locale: 'en' | 'uk' = 'en') {
  return {
    user: { telegramId: 100, name: 'Alex', role, locale, muted: false, quietStart: null, quietEnd: null, createdAt: null },
    locale,
    catalog: catalogFor(locale),
  };
}

function setup() {
  const guard = { registered: vi.fn() } as unknown as RoleMiddleware;
  const status = { handleCommand: vi.fn() }; const health = { handleCommand: vi.fn() };
  const camera = { handleDashboard: vi.fn() }; const gdrive = { handleStatus: vi.fn() };
  const invite = { handleCommand: vi.fn() }; const exportConfig = { handleCommand: vi.fn() };
  const logs = { handleEmpty: vi.fn() }; const mute = { handleEmpty: vi.fn(), handleMuteAll: vi.fn() };
  const unmute = { handleEmpty: vi.fn(), handleUnmuteAll: vi.fn() }; const config = { handleSubcommand: vi.fn() };
  const importConfig = { handleCommand: vi.fn() }; const systemUpdate = { handleCommand: vi.fn() };
  const restart = { handleCommand: vi.fn() }; const quiet = { handlePreset: vi.fn() };
  const settings = { handleCommand: vi.fn() }; const clean = { handleCommand: vi.fn() };
  const gdriveAuth = { handleCommand: vi.fn() }; const csv = { handleEmpty: vi.fn() };
  const handler = new LegacyMenuHandler(
    guard, status as any, health as any, camera as any, gdrive as any, invite as any,
    exportConfig as any, logs as any, mute as any, unmute as any, config as any,
    importConfig as any, systemUpdate as any, restart as any, quiet as any,
    settings as any, clean as any, gdriveAuth as any, csv as any,
  );
  const callbacks: { regex: RegExp; fn: (ctx: any) => Promise<void> }[] = [];
  const composer = {
    command: vi.fn(),
    callbackQuery: vi.fn((regex, middleware, fn) => callbacks.push({ regex, fn: fn ?? middleware })),
  } as any;
  handler.register(composer);
  return { handler, composer, callbacks, mute, unmute, quiet };
}

describe('LegacyMenuHandler', () => {
  it('registers only explicit legacy-menu callbacks, never /menu', () => {
    const { composer, callbacks } = setup();
    expect(composer.command).not.toHaveBeenCalled();
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0].regex.test('legacy-menu:status')).toBe(true);
    expect(callbacks[0].regex.test('menu:status')).toBe(false);
  });

  it('opens the legacy dashboard as a new message with legacy callbacks', async () => {
    const { handler } = setup();
    const reply = vi.fn().mockResolvedValue(undefined);
    await handler.openDashboard({ localeState: state('admin'), reply } as any);

    expect(reply).toHaveBeenCalledWith(
      expect.any(String), expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(JSON.stringify(reply.mock.calls[0][1].reply_markup)).toContain('legacy-menu:');
    expect(JSON.stringify(reply.mock.calls[0][1].reply_markup)).not.toContain('"callback_data":"menu:');
  });

  it('opens localized notification controls as a separate message', async () => {
    const { handler } = setup();
    const reply = vi.fn().mockResolvedValue(undefined);
    await handler.openNotifications({ localeState: state('user', 'uk'), reply } as any);

    expect(reply).toHaveBeenCalledWith(
      state('user', 'uk').catalog.home.legacyNotifications.title,
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    const keyboard = JSON.stringify(reply.mock.calls[0][1].reply_markup);
    expect(keyboard).toContain('legacy-menu:act:mute');
    expect(keyboard).toContain('legacy-menu:act:unmute');
    expect(keyboard).toContain('legacy-menu:sub:quiet');
  });

  it('delegates legacy notification actions through the current handlers', async () => {
    const { callbacks, mute, unmute, quiet } = setup();
    const callback = callbacks[0].fn;
    const base = { localeState: state(), answerCallbackQuery: vi.fn().mockResolvedValue(undefined), reply: vi.fn(), editMessageText: vi.fn() };
    await callback({ ...base, match: ['legacy-menu:act:mute', 'act:mute'] });
    await callback({ ...base, match: ['legacy-menu:act:unmute', 'act:unmute'] });
    await callback({ ...base, match: ['legacy-menu:act:quiet:off', 'act:quiet:off'] });
    expect(mute.handleEmpty).toHaveBeenCalled();
    expect(unmute.handleEmpty).toHaveBeenCalled();
    expect(quiet.handlePreset).toHaveBeenCalledWith(expect.anything(), 'off');
  });
});

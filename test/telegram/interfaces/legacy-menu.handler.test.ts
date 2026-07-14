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

  it('does not expose transitional Home panels or a top-level notifications route', async () => {
    const { handler, callbacks } = setup();
    const reply = vi.fn().mockResolvedValue(undefined);
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const callback = callbacks[0].fn;

    expect('openDashboard' in handler).toBe(false);
    expect('openNotifications' in handler).toBe(false);
    await callback({
      localeState: state('admin'),
      match: ['legacy-menu:top', 'top'],
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      reply,
      editMessageText,
    });
    expect(JSON.stringify(editMessageText.mock.calls[0][1].reply_markup)).not.toContain('legacy-menu:sub:notifications');

    await callback({
      localeState: state(),
      match: ['legacy-menu:sub:notifications', 'sub:notifications'],
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      reply,
      editMessageText,
    });
    expect(reply).not.toHaveBeenCalled();
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

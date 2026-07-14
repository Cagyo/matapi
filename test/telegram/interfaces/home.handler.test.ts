import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { OpenHomeUseCase } from '../../../src/telegram/application/open-home.use-case';
import { RenderHomeUseCase } from '../../../src/telegram/application/render-home.use-case';
import { RefreshHomeMonitoringUseCase } from '../../../src/telegram/application/refresh-home-monitoring.use-case';
import { ValidateHomeCallbackUseCase } from '../../../src/telegram/application/validate-home-callback.use-case';
import { CloseHomeUseCase } from '../../../src/telegram/application/close-home.use-case';
import { HomeNavigationUseCase } from '../../../src/telegram/application/home-navigation.use-case';
import { HomeHandler } from '../../../src/telegram/interfaces/home.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import { encodeHomeCallback } from '../../../src/telegram/domain/home-callback';

const identity = {
  userId: 100,
  chatId: 200,
  messageId: 300,
  token: 'AbCdEfGhIjKlMn_-',
  revision: 1,
};

function localeState(role: 'admin' | 'user' = 'user', locale: 'en' | 'uk' = 'en') {
  return {
    user: { telegramId: 100, name: 'Alex', role, locale, muted: false, quietStart: null, quietEnd: null, createdAt: null },
    locale,
    catalog: catalogFor(locale),
  };
}

function context(data?: string) {
  return {
    from: { id: 100 },
    chat: { id: 200, type: 'private' },
    callbackQuery: data ? { data, message: { message_id: 300 } } : undefined,
    localeState: localeState(),
    reply: vi.fn().mockResolvedValue({ message_id: 301 }),
  };
}

function setup() {
  const guard = { registered: vi.fn() } as unknown as RoleMiddleware;
  const open = {
    execute: vi.fn().mockResolvedValue({ kind: 'opened', active: identity, view: { kind: 'home', checking: false } }),
  } as unknown as OpenHomeUseCase;
  const validate = { execute: vi.fn().mockResolvedValue({ kind: 'accepted', active: identity, view: { kind: 'home', checking: false } }) } as unknown as ValidateHomeCallbackUseCase;
  const render = {
    execute: vi.fn().mockResolvedValue({
      kind: 'rendered', active: { ...identity, revision: 2 }, view: { kind: 'home', checking: false },
    }),
  } as unknown as RenderHomeUseCase;
  const refresh = { execute: vi.fn().mockResolvedValue({ kind: 'refreshed' }) } as unknown as RefreshHomeMonitoringUseCase;
  const close = { execute: vi.fn().mockResolvedValue('closed') } as unknown as CloseHomeUseCase;
  const camera = { handleDashboard: vi.fn().mockResolvedValue(undefined) } as any;
  const legacy = {
    openDashboard: vi.fn().mockResolvedValue(undefined),
    openNotifications: vi.fn().mockResolvedValue(undefined),
  } as any;
  const navigation = { execute: vi.fn().mockImplementation(({ action }: any) => Promise.resolve({
    kind: 'render',
    view: action.kind === 'sensors'
      ? { kind: 'sensors', page: action.page, checking: false }
      : action.kind === 'home'
        ? { kind: 'home', checking: false }
        : { kind: 'notifications' },
  })) } as unknown as HomeNavigationUseCase;
  const handler = new HomeHandler(guard, open, validate, render, refresh, close, camera, legacy, navigation);
  const commands: Record<string, (...args: any[]) => Promise<void>> = {};
  const callbacks: { regex: RegExp; fn: (...args: any[]) => Promise<void> }[] = [];
  handler.register({
    command: vi.fn((name, middleware, fn) => { commands[name] = fn ?? middleware; }),
    callbackQuery: vi.fn((regex, middleware, fn) => { callbacks.push({ regex, fn: fn ?? middleware }); }),
  } as any);
  return { commands, callbacks, open, validate, render, refresh, close, camera, legacy, navigation };
}

describe('HomeHandler', () => {
  it('opens Home from /menu for the current registered private user without probing health', async () => {
    const { commands, open, refresh } = setup();
    const ctx = context();

    await commands.menu(ctx);

    expect(open.execute).toHaveBeenCalledWith({
      userId: 100, chatId: 200, locale: 'en', role: 'user', view: { kind: 'home', checking: false },
    });
    expect(refresh.execute).not.toHaveBeenCalled();
  });

  it('recovers malformed callbacks without mutating Home state', async () => {
    const { callbacks, validate, render, refresh, close, camera, legacy } = setup();
    const ctx = context('h:not-a-token:1:k');

    await callbacks[0].fn(ctx);

    expect(validate.execute).not.toHaveBeenCalled();
    expect(render.execute).not.toHaveBeenCalled();
    expect(refresh.execute).not.toHaveBeenCalled();
    expect(close.execute).not.toHaveBeenCalled();
    expect(camera.handleDashboard).not.toHaveBeenCalled();
    expect(legacy.openDashboard).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      ctx.localeState.catalog.home.recovery.stale,
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
  });

  it('renders the requested Sensors page using the current locale and role after validation', async () => {
    const { callbacks, validate, render } = setup();
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'sensors', page: 4 }));
    ctx.localeState = localeState('admin', 'uk');

    await callbacks[0].fn(ctx);

    expect(validate.execute).toHaveBeenCalledWith({ parsed: expect.anything(), userId: 100, chatId: 200, messageId: 300 });
    expect(render.execute).toHaveBeenCalledWith({
      active: identity, locale: 'uk', role: 'admin', view: { kind: 'sensors', page: 4, checking: false },
    });
  });

  it('keeps the page clamped while a refresh grows the sensor list', async () => {
    const { callbacks, validate, render, refresh } = setup();
    const checkingIdentity = { ...identity, revision: 2 };
    (validate.execute as any).mockResolvedValue({ kind: 'accepted', active: identity, view: { kind: 'sensors', page: 3, checking: false } });
    (render.execute as any)
      .mockResolvedValueOnce({
        kind: 'reopened', active: checkingIdentity,
        view: { kind: 'sensors', page: 0, checking: true },
      })
      .mockResolvedValueOnce({
        kind: 'rendered', active: { ...identity, revision: 3 },
        view: { kind: 'sensors', page: 0, checking: false },
      });
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'check' }));

    await callbacks[0].fn(ctx);

    expect(render.execute).toHaveBeenNthCalledWith(1, {
      active: identity, locale: 'en', role: 'user', view: { kind: 'sensors', page: 3, checking: true },
    });
    expect(refresh.execute).toHaveBeenCalledTimes(1);
    expect(render.execute).toHaveBeenNthCalledWith(2, {
      active: checkingIdentity, locale: 'en', role: 'user', view: { kind: 'sensors', page: 0, checking: false },
    });
  });

  it('clears the checking state after an unexpected refresh failure', async () => {
    const { callbacks, render, refresh } = setup();
    (refresh.execute as any).mockRejectedValue(new Error('probe unavailable'));
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'check' }));

    await callbacks[0].fn(ctx);

    expect(render.execute).toHaveBeenCalledTimes(2);
    expect(render.execute).toHaveBeenLastCalledWith(expect.objectContaining({
      view: { kind: 'home', checking: false },
    }));
  });

  it.each([
    ['updating', 'updating'],
    ['stale', 'stale'],
    ['closed', 'stale'],
  ] as const)('fails closed for %s callback state', async (kind, copy) => {
    const { callbacks, validate, render, camera, legacy } = setup();
    (validate.execute as any).mockResolvedValue({ kind });
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'camera' }));

    await callbacks[0].fn(ctx);

    expect(render.execute).not.toHaveBeenCalled();
    expect(camera.handleDashboard).not.toHaveBeenCalled();
    expect(legacy.openDashboard).not.toHaveBeenCalled();
    if (copy === 'updating') {
      expect(ctx.reply).toHaveBeenCalledWith(ctx.localeState.catalog.home.recovery.updating);
    } else {
      expect(ctx.reply).toHaveBeenCalledWith(
        ctx.localeState.catalog.home.recovery.stale,
        expect.objectContaining({ reply_markup: expect.anything() }),
      );
    }
  });

  it('routes Notifications through Home navigation and renders its returned Home view', async () => {
    const { callbacks, render, navigation, legacy } = setup();
    const ctx = context(encodeHomeCallback(identity.token, 1, { kind: 'notifications' }));

    await callbacks[0].fn(ctx);

    expect(navigation.execute).toHaveBeenCalledWith(expect.objectContaining({ action: { kind: 'notifications' } }));
    expect(render.execute).toHaveBeenCalledWith(expect.objectContaining({ view: { kind: 'notifications' } }));
    expect(legacy.openNotifications).not.toHaveBeenCalled();
  });

  it('delegates camera to its separate workflow without rendering Home', async () => {
    const { callbacks, render, camera } = setup();
    const action = { kind: 'camera' } as const;
    const ctx = context(encodeHomeCallback(identity.token, 1, action));

    await callbacks[0].fn(ctx);

    expect(render.execute).not.toHaveBeenCalled();
    expect(camera.handleDashboard).toHaveBeenCalledWith(ctx);
  });
});

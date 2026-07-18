import { describe, expect, it, vi } from 'vitest';
import { homeCallbackAckMiddleware } from '../../../src/telegram/interfaces/home-callback-ack.middleware';
import { homeUpdateConstraints } from '../../../src/telegram/interfaces/home-update-constraints';
import { GrammyBotGateway } from '../../../src/telegram/infrastructure/grammy-bot.gateway';
import { TelegramHomeMessageAdapter } from '../../../src/telegram/infrastructure/telegram-home-message.adapter';
import { TelegramHandler } from '../../../src/telegram/interfaces/telegram-handler';

const mocks = vi.hoisted(() => {
  const botUse = vi.fn();
  const bot = {
    api: { config: { use: vi.fn() } },
    use: botUse,
    catch: vi.fn(),
  };
  const sequentializedMiddleware = vi.fn();
  const sequentialize = vi.fn(() => sequentializedMiddleware);
  const run = vi.fn(() => ({ isRunning: () => true }));
  return { bot, botUse, sequentializedMiddleware, sequentialize, run };
});

vi.mock('grammy', () => ({
  Bot: class {
    constructor() {
      return mocks.bot;
    }
  },
  GrammyError: class GrammyError extends Error {},
  HttpError: class HttpError extends Error {},
}));

vi.mock('@grammyjs/runner', () => ({
  run: mocks.run,
  sequentialize: mocks.sequentialize,
}));

describe('GrammyBotGateway handler registration', () => {
  it('installs Home acknowledgement and sequentialization before locale resolution', async () => {
    mocks.botUse.mockClear();
    mocks.bot.api.config.use.mockClear();
    const handler = { register: vi.fn() } as TelegramHandler;
    const resolveOptional = vi.fn();
    const gateway = Object.create(GrammyBotGateway.prototype);
    Object.assign(gateway, {
      mode: 'real',
      token: '123456:token',
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      lastUpdateAt: null,
      liveStreamMessageCleanup: { register: vi.fn() },
      telegramLiveStreamMessageCleanup: { setBot: vi.fn() },
      homeMessageDelivery: Object.assign(Object.create(TelegramHomeMessageAdapter.prototype), { setBot: vi.fn() }),
      eventNotifier: { register: vi.fn() },
      recipientDirectory: { register: vi.fn() },
      adminAlertService: { register: vi.fn() },
      otaAdminNotifications: { register: vi.fn() },
      eventProcessor: { drain: vi.fn() },
      telegramNotifier: { setBot: vi.fn() },
      directMessenger: { setBot: vi.fn() },
      botCommandsMenu: { setBot: vi.fn(), syncAllUsers: vi.fn().mockResolvedValue(undefined) },
      telegramRecipients: {},
      telegramAdminAlert: {},
      telegramOtaAdminNotifications: {},
      botRunnerRegistry: { register: vi.fn() },
      restartConfirmation: { run: vi.fn().mockResolvedValue(undefined) },
      systemOnline: { run: vi.fn().mockResolvedValue(undefined) },
      localeMiddleware: { resolveOptional },
      claim: handler, mute: handler, unmute: handler, quietHours: handler, update: handler,
      systemUpdate: handler, rollback: handler, restartHandler: handler, start: handler,
      status: handler, ping: handler, help: handler, logs: handler, health: handler,
      config: handler, invite: handler, promote: handler, demote: handler, camera: handler,
      gdrive: handler, exportConfig: handler, importConfig: handler, feature: handler,
      gdriveAuth: handler, csv: handler, home: handler, workflowNavigation: handler, legacyMenu: handler, settings: handler, clean: handler,
    });

    await gateway.onApplicationBootstrap();

    expect(mocks.sequentialize).toHaveBeenCalledWith(homeUpdateConstraints);
    expect(mocks.botUse.mock.calls.map((call) => call[0] as unknown)).toEqual([
      expect.any(Function),
      expect.any(Function),
      homeCallbackAckMiddleware,
      mocks.sequentializedMiddleware,
      resolveOptional,
    ]);
    expect(gateway.homeMessageDelivery.setBot).toHaveBeenCalledWith(mocks.bot);
    expect(gateway.otaAdminNotifications.register).toHaveBeenCalledWith(
      gateway.telegramOtaAdminNotifications,
    );
  });

  it('registers exact workflow navigation before broad workflow callback handlers', () => {
    const gateway = Object.create(GrammyBotGateway.prototype) as {
      handlers(): TelegramHandler[];
      [key: string]: unknown;
    };
    const workflowNavigation = {} as TelegramHandler;
    const csv = {} as TelegramHandler;
    const config = {} as TelegramHandler;
    const settings = {} as TelegramHandler;
    const camera = {} as TelegramHandler;
    const gdrive = {} as TelegramHandler;
    const home = {} as TelegramHandler;
    const legacyMenu = {} as TelegramHandler;
    Object.assign(gateway, {
      claim: {}, mute: {}, unmute: {}, quietHours: {}, update: {}, systemUpdate: {},
      rollback: {}, restartHandler: {}, start: {}, status: {}, ping: {}, help: {},
      logs: {}, health: {}, config, invite: {}, promote: {}, demote: {}, camera,
      gdrive, exportConfig: {}, importConfig: {}, feature: {}, gdriveAuth: {},
      csv, home, workflowNavigation, legacyMenu, settings, clean: {},
    });

    const handlers = gateway.handlers();

    expect(handlers.filter((handler) => handler === workflowNavigation)).toHaveLength(1);
    for (const broadWorkflowHandler of [config, settings, camera, gdrive, csv, home]) {
      expect(handlers.indexOf(workflowNavigation)).toBeLessThan(handlers.indexOf(broadWorkflowHandler));
    }
    expect(handlers.filter((handler) => handler === csv)).toHaveLength(1);
    expect(handlers.indexOf(workflowNavigation)).toBeLessThan(handlers.indexOf(legacyMenu));
  });

  it('registers the Telegram live-message cleanup seam at bootstrap in mock mode', async () => {
    const gateway = Object.create(GrammyBotGateway.prototype);
    const telegramCleanup = {};
    const register = vi.fn();
    Object.assign(gateway, {
      mode: 'mock',
      token: undefined,
      logger: { warn: vi.fn() },
      eventNotifier: { register: vi.fn() },
      recipientDirectory: { register: vi.fn() },
      adminAlertService: { register: vi.fn() },
      otaAdminNotifications: { register: vi.fn() },
      eventProcessor: { drain: vi.fn() },
      consoleNotifier: {},
      telegramRecipients: {},
      telegramAdminAlert: {},
      telegramOtaAdminNotifications: {},
      liveStreamMessageCleanup: { register },
      telegramLiveStreamMessageCleanup: telegramCleanup,
    });

    await gateway.onApplicationBootstrap();

    expect(register).toHaveBeenCalledWith(telegramCleanup);
    expect(gateway.otaAdminNotifications.register).toHaveBeenCalledWith(
      gateway.telegramOtaAdminNotifications,
    );
  });

  it('clears the Telegram live-message cleanup seam on shutdown', async () => {
    const gateway = Object.create(GrammyBotGateway.prototype);
    const clear = vi.fn();
    const clearBot = vi.fn();
    Object.assign(gateway, {
      botRunnerRegistry: { clear: vi.fn() },
      telegramNotifier: { clearBot: vi.fn() },
      directMessenger: { clearBot: vi.fn() },
      botCommandsMenu: { clearBot: vi.fn() },
      telegramLiveStreamMessageCleanup: { clearBot },
      homeMessageDelivery: Object.assign(Object.create(TelegramHomeMessageAdapter.prototype), { clearBot: vi.fn() }),
      eventNotifier: { clear: vi.fn() },
      recipientDirectory: { clear: vi.fn() },
      adminAlertService: { clear: vi.fn() },
      otaAdminNotifications: { clear: vi.fn() },
      liveStreamMessageCleanup: { clear },
    });

    await gateway.onModuleDestroy();

    expect(clearBot).toHaveBeenCalledTimes(1);
    expect(gateway.homeMessageDelivery.clearBot).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(gateway.otaAdminNotifications.clear).toHaveBeenCalledTimes(1);
  });

  it('clears stale update freshness after a successful runner restart', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const gateway = Object.create(GrammyBotGateway.prototype);
    Object.assign(gateway, {
      bot: {},
      runner: { isRunning: () => true, stop },
      lastUpdateAt: new Date('2030-01-01T00:00:00.000Z'),
      logger: { warn: vi.fn() },
    });

    await gateway.restart();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(gateway.getLastUpdateAt()).toBeNull();
  });

  it('retains stale update freshness when replacement runner startup fails', async () => {
    const stale = new Date('2030-01-01T00:00:00.000Z');
    const gateway = Object.create(GrammyBotGateway.prototype);
    Object.assign(gateway, {
      bot: {},
      runner: { isRunning: () => false },
      lastUpdateAt: stale,
      logger: { warn: vi.fn() },
    });
    mocks.run.mockImplementationOnce(() => {
      throw new Error('runner failed');
    });

    await expect(gateway.restart()).rejects.toThrow('runner failed');

    expect(gateway.getLastUpdateAt()).toBe(stale);
  });
});

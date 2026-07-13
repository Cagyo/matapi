import { describe, expect, it, vi } from 'vitest';
import { GrammyBotGateway } from '../../../src/telegram/infrastructure/grammy-bot.gateway';
import { TelegramHandler } from '../../../src/telegram/interfaces/telegram-handler';

describe('GrammyBotGateway handler registration', () => {
  it('registers CsvHandler exactly once before MenuHandler', () => {
    const gateway = Object.create(GrammyBotGateway.prototype) as {
      handlers(): TelegramHandler[];
      [key: string]: unknown;
    };
    const csv = {} as TelegramHandler;
    const menu = {} as TelegramHandler;
    Object.assign(gateway, {
      claim: {}, mute: {}, unmute: {}, quietHours: {}, update: {}, systemUpdate: {},
      rollback: {}, restartHandler: {}, start: {}, status: {}, ping: {}, help: {},
      logs: {}, health: {}, config: {}, invite: {}, promote: {}, demote: {}, camera: {},
      gdrive: {}, exportConfig: {}, importConfig: {}, feature: {}, gdriveAuth: {},
      csv, menu, settings: {}, clean: {},
    });

    const handlers = gateway.handlers();

    expect(handlers.filter((handler) => handler === csv)).toHaveLength(1);
    expect(handlers.indexOf(csv)).toBeLessThan(handlers.indexOf(menu));
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
      eventProcessor: { drain: vi.fn() },
      consoleNotifier: {},
      telegramRecipients: {},
      telegramAdminAlert: {},
      liveStreamMessageCleanup: { register },
      telegramLiveStreamMessageCleanup: telegramCleanup,
    });

    await gateway.onApplicationBootstrap();

    expect(register).toHaveBeenCalledWith(telegramCleanup);
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
      eventNotifier: { clear: vi.fn() },
      recipientDirectory: { clear: vi.fn() },
      adminAlertService: { clear: vi.fn() },
      liveStreamMessageCleanup: { clear },
    });

    await gateway.onModuleDestroy();

    expect(clearBot).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

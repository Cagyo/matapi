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

/** Telegram's own wording quotes the chat and the message it refused. */
const TELEGRAM_TEXT = 'Bad Request: message to delete not found (chat 907001, message 550123)';

/** The gateway with its collaborators replaced by stubs the test can read. */
type StubbedGateway = GrammyBotGateway & Record<string, any>;

/** A real-mode gateway with every collaborator stubbed, ready to bootstrap. */
function realGateway(overrides: Record<string, unknown> = {}): StubbedGateway {
  mocks.botUse.mockClear();
  mocks.bot.api.config.use.mockClear();
  // `mocks.run` is module-scoped, so its call order accumulates across tests;
  // clearing here keeps every ordering assertion local to its own bootstrap.
  mocks.run.mockClear();
  const handler = { register: vi.fn() } as TelegramHandler;
  const gateway = Object.create(GrammyBotGateway.prototype) as StubbedGateway;
  Object.assign(gateway, {
    mode: 'real',
    token: '123456:token',
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    lastUpdateAt: null,
    liveStreamMessageCleanup: { register: vi.fn() },
    telegramLiveStreamMessageCleanup: { setBot: vi.fn() },
    telegramCameraSourceMessage: { setBot: vi.fn(), clearBot: vi.fn() },
    recoverCameraSourcePrompts: {
      execute: vi.fn().mockResolvedValue({ attempted: 0, failed: 0 }),
    },
    homeMessageDelivery: Object.assign(Object.create(TelegramHomeMessageAdapter.prototype), { setBot: vi.fn() }),
    eventNotifier: { register: vi.fn() },
    recipientDirectory: { register: vi.fn() },
    adminAlertService: { register: vi.fn() },
    archiveAdminAlerts: { register: vi.fn() },
    telegramArchiveAdminAlert: {},
    eventProcessor: { drain: vi.fn() },
    telegramNotifier: { setBot: vi.fn() },
    directMessenger: { setBot: vi.fn() },
    botCommandsMenu: { setBot: vi.fn(), syncAllUsers: vi.fn().mockResolvedValue(undefined) },
    telegramRecipients: {},
    telegramAdminAlert: {},
    botRunnerRegistry: { register: vi.fn() },
    restartConfirmation: { run: vi.fn().mockResolvedValue(undefined) },
    systemOnline: { run: vi.fn().mockResolvedValue(undefined) },
    localeMiddleware: { resolveOptional: vi.fn() },
    claim: handler, mute: handler, unmute: handler, quietHours: handler, update: handler,
    systemUpdate: handler, rollback: handler, restartHandler: handler, start: handler,
    status: handler, ping: handler, help: handler, logs: handler, health: handler,
    config: handler, invite: handler, promote: handler, demote: handler, camera: handler,
    gdrive: handler, exportConfig: handler, importConfig: handler, feature: handler,
    csv: handler, home: handler, workflowNavigation: handler, legacyMenu: handler, settings: handler, clean: handler,
    ...overrides,
  });
  return gateway;
}

/** Lets the fire-and-forget bootstrap follow-ups settle their handlers. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('GrammyBotGateway handler registration', () => {
  it('installs Home acknowledgement and sequentialization before locale resolution', async () => {
    const gateway = realGateway();

    await gateway.onApplicationBootstrap();

    expect(mocks.sequentialize).toHaveBeenCalledWith(homeUpdateConstraints);
    expect(mocks.botUse.mock.calls.map((call) => call[0] as unknown)).toEqual([
      expect.any(Function),
      expect.any(Function),
      homeCallbackAckMiddleware,
      mocks.sequentializedMiddleware,
      gateway.localeMiddleware.resolveOptional,
    ]);
    expect(gateway.homeMessageDelivery.setBot).toHaveBeenCalledWith(mocks.bot);
  });

  it('arms the camera-source message adapter and recovers prompts before the update pump', async () => {
    const gateway = realGateway();

    await gateway.onApplicationBootstrap();

    expect(gateway.telegramCameraSourceMessage.setBot).toHaveBeenCalledWith(mocks.bot);
    expect(gateway.recoverCameraSourcePrompts.execute).toHaveBeenCalledTimes(1);
    expect(gateway.recoverCameraSourcePrompts.execute.mock.calls[0][0]).toBeInstanceOf(Date);
    const recovery = gateway.recoverCameraSourcePrompts.execute.mock.invocationCallOrder[0];
    // The adapter must hold the bot before recovery asks it to delete.
    expect(gateway.telegramCameraSourceMessage.setBot.mock.invocationCallOrder[0])
      .toBeLessThan(recovery);
    // The real hazard is the runner: once it polls, a live reply handler can
    // reach `claimReply` on a row already inside recovery's snapshot.
    expect(recovery).toBeLessThan(mocks.run.mock.invocationCallOrder[0]);
    expect(recovery).toBeLessThan(gateway.botCommandsMenu.syncAllUsers.mock.invocationCallOrder[0]);
    expect(recovery).toBeLessThan(gateway.eventProcessor.drain.mock.invocationCallOrder[0]);
  });

  it('completes bootstrap when prompt recovery fails, without echoing Telegram text', async () => {
    const gateway = realGateway({
      recoverCameraSourcePrompts: {
        execute: vi.fn().mockRejectedValue(new Error(TELEGRAM_TEXT)),
      },
    });

    await expect(gateway.onApplicationBootstrap()).resolves.toBeUndefined();
    await settle();

    expect(gateway.botCommandsMenu.syncAllUsers).toHaveBeenCalledTimes(1);
    const warned = gateway.logger.warn.mock.calls.flat().map((entry: unknown) => String(entry));
    expect(warned.some((entry: string) => entry.includes('camera source prompt recovery'))).toBe(true);
    for (const secret of [TELEGRAM_TEXT, 'message to delete not found', '907001', '550123']) {
      expect(warned.join('\n')).not.toContain(secret);
    }
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
      gdrive, exportConfig: {}, importConfig: {}, feature: {},
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
      archiveAdminAlerts: { register: vi.fn() },
      telegramArchiveAdminAlert: {},
      eventProcessor: { drain: vi.fn() },
      consoleNotifier: {},
      telegramRecipients: {},
      telegramAdminAlert: {},
      liveStreamMessageCleanup: { register },
      telegramLiveStreamMessageCleanup: telegramCleanup,
      telegramCameraSourceMessage: { setBot: vi.fn() },
      recoverCameraSourcePrompts: { execute: vi.fn() },
    });

    await gateway.onApplicationBootstrap();

    expect(register).toHaveBeenCalledWith(telegramCleanup);
    // No bot exists in mock mode, so every deletion would fail closed and
    // stamp `deletionFailed` on rows nobody ever tried to clean.
    expect(gateway.telegramCameraSourceMessage.setBot).not.toHaveBeenCalled();
    expect(gateway.recoverCameraSourcePrompts.execute).not.toHaveBeenCalled();
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
      telegramCameraSourceMessage: { clearBot: vi.fn() },
      homeMessageDelivery: Object.assign(Object.create(TelegramHomeMessageAdapter.prototype), { clearBot: vi.fn() }),
      eventNotifier: { clear: vi.fn() },
      recipientDirectory: { clear: vi.fn() },
      adminAlertService: { clear: vi.fn() },
      archiveAdminAlerts: { clear: vi.fn() },
      liveStreamMessageCleanup: { clear },
    });

    await gateway.onModuleDestroy();

    expect(clearBot).toHaveBeenCalledTimes(1);
    expect(gateway.telegramCameraSourceMessage.clearBot).toHaveBeenCalledTimes(1);
    expect(gateway.homeMessageDelivery.clearBot).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
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

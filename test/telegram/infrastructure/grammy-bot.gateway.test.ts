import { describe, expect, it } from 'vitest';
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
});

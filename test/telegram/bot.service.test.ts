import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotService } from '../../src/telegram/bot.service';

const originalToken = process.env.TELEGRAM_BOT_TOKEN;

function restoreToken(): void {
  if (originalToken === undefined) {
    delete process.env.TELEGRAM_BOT_TOKEN;
    return;
  }
  process.env.TELEGRAM_BOT_TOKEN = originalToken;
}

function makeService() {
  const eventNotifier = { register: vi.fn(), clear: vi.fn() };
  const eventProcessor = { drain: vi.fn().mockResolvedValue(undefined) };
  const telegramNotifier = { setBot: vi.fn(), clearBot: vi.fn() };
  const claim = { register: vi.fn() };
  const status = { register: vi.fn() };
  const ping = { register: vi.fn() };
  const help = { register: vi.fn() };
  const service = new BotService(
    eventNotifier as never,
    eventProcessor as never,
    telegramNotifier as never,
    claim as never,
    status as never,
    ping as never,
    help as never,
  );

  return { service, eventNotifier, eventProcessor, telegramNotifier, claim, status, ping, help };
}

describe('BotService', () => {
  afterEach(() => {
    restoreToken();
  });

  it('leaves the bot disabled when TELEGRAM_BOT_TOKEN is missing', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const { service, eventNotifier, eventProcessor, telegramNotifier, claim } = makeService();

    await service.onApplicationBootstrap();

    expect(claim.register).not.toHaveBeenCalled();
    expect(telegramNotifier.setBot).not.toHaveBeenCalled();
    expect(eventNotifier.register).not.toHaveBeenCalled();
    expect(eventProcessor.drain).not.toHaveBeenCalled();
  });

  it('stops a running bot runner and clears notifier bindings on destroy', async () => {
    const { service, eventNotifier, telegramNotifier } = makeService();
    const stop = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { runner: { isRunning(): boolean; stop(): Promise<void> } }).runner = {
      isRunning: () => true,
      stop,
    };

    await service.onModuleDestroy();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(telegramNotifier.clearBot).toHaveBeenCalledTimes(1);
    expect(eventNotifier.clear).toHaveBeenCalledTimes(1);
  });
});
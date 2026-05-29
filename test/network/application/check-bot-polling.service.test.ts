import { describe, expect, it, vi } from 'vitest';
import { BotRunnerRegistry } from '../../../src/network/application/bot-runner.registry';
import { CheckBotPollingService } from '../../../src/network/application/check-bot-polling.service';
import type { BotRunnerPort } from '../../../src/network/domain/ports/bot-runner.port';
import type { ClockPort } from '../../../src/events/domain/ports/clock.port';

const NOW = new Date('2030-01-01T12:00:00Z');
const fixedClock: ClockPort = { now: () => NOW };

function delegate(
  overrides: Partial<BotRunnerPort> = {},
): BotRunnerPort & { restart: ReturnType<typeof vi.fn> } {
  return {
    getLastUpdateAt: () => NOW,
    isRunning: () => true,
    restart: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as BotRunnerPort & { restart: ReturnType<typeof vi.fn> };
}

describe('CheckBotPollingService', () => {
  it('treats a fresh bot with no updates as healthy', () => {
    const registry = new BotRunnerRegistry();
    registry.register(delegate({ getLastUpdateAt: () => null }));
    const service = new CheckBotPollingService(fixedClock, registry);

    expect(service.isBotPollingHealthy()).toBe(true);
  });

  it('is healthy when the last update is within the stall window', () => {
    const registry = new BotRunnerRegistry();
    const recent = new Date(NOW.getTime() - 119_000);
    registry.register(delegate({ getLastUpdateAt: () => recent }));
    const service = new CheckBotPollingService(fixedClock, registry);

    expect(service.isBotPollingHealthy()).toBe(true);
  });

  it('is unhealthy once the last update exceeds the stall window', () => {
    const registry = new BotRunnerRegistry();
    const stale = new Date(NOW.getTime() - 120_001);
    registry.register(delegate({ getLastUpdateAt: () => stale }));
    const service = new CheckBotPollingService(fixedClock, registry);

    expect(service.isBotPollingHealthy()).toBe(false);
  });

  it('does nothing when no runner is registered (mock mode)', async () => {
    const registry = new BotRunnerRegistry();
    const service = new CheckBotPollingService(fixedClock, registry);

    await expect(service.check()).resolves.toBeUndefined();
  });

  it('restarts the runner when polling is stalled', async () => {
    const registry = new BotRunnerRegistry();
    const runner = delegate({
      getLastUpdateAt: () => new Date(NOW.getTime() - 200_000),
    });
    registry.register(runner);
    const service = new CheckBotPollingService(fixedClock, registry);

    await service.check();

    expect(runner.restart).toHaveBeenCalledTimes(1);
  });

  it('does not restart a healthy runner', async () => {
    const registry = new BotRunnerRegistry();
    const runner = delegate();
    registry.register(runner);
    const service = new CheckBotPollingService(fixedClock, registry);

    await service.check();

    expect(runner.restart).not.toHaveBeenCalled();
  });

  it('swallows a failed restart so the next tick can retry', async () => {
    const registry = new BotRunnerRegistry();
    const runner = delegate({
      getLastUpdateAt: () => new Date(NOW.getTime() - 200_000),
      restart: vi.fn().mockRejectedValue(new Error('stop failed')),
    });
    registry.register(runner);
    const service = new CheckBotPollingService(fixedClock, registry);

    await expect(service.check()).resolves.toBeUndefined();
    expect(runner.restart).toHaveBeenCalledTimes(1);
  });
});

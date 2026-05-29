import { describe, expect, it, vi } from 'vitest';
import { BotRunnerRegistry } from '../../../src/network/application/bot-runner.registry';
import type { BotRunnerPort } from '../../../src/network/domain/ports/bot-runner.port';

describe('BotRunnerRegistry', () => {
  it('reports no runner and is a no-op before a delegate is registered', async () => {
    const registry = new BotRunnerRegistry();

    expect(registry.hasRunner()).toBe(false);
    expect(registry.getLastUpdateAt()).toBeNull();
    expect(registry.isRunning()).toBe(false);
    await expect(registry.restart()).resolves.toBeUndefined();
  });

  it('delegates to the registered runner', async () => {
    const last = new Date('2030-01-01T00:00:00Z');
    const delegate: BotRunnerPort = {
      getLastUpdateAt: () => last,
      isRunning: () => true,
      restart: vi.fn().mockResolvedValue(undefined),
    };
    const registry = new BotRunnerRegistry();
    registry.register(delegate);

    expect(registry.hasRunner()).toBe(true);
    expect(registry.getLastUpdateAt()).toBe(last);
    expect(registry.isRunning()).toBe(true);
    await registry.restart();
    expect(delegate.restart).toHaveBeenCalledTimes(1);
  });

  it('stops delegating after clear', () => {
    const delegate: BotRunnerPort = {
      getLastUpdateAt: () => new Date(),
      isRunning: () => true,
      restart: vi.fn(),
    };
    const registry = new BotRunnerRegistry();
    registry.register(delegate);
    registry.clear();

    expect(registry.hasRunner()).toBe(false);
    expect(registry.isRunning()).toBe(false);
    expect(registry.getLastUpdateAt()).toBeNull();
  });
});

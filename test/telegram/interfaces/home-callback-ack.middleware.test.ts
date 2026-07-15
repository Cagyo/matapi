import { describe, expect, it, vi } from 'vitest';
import { homeCallbackAckMiddleware } from '../../../src/telegram/interfaces/home-callback-ack.middleware';
import type { TelegramContext } from '../../../src/telegram/interfaces/telegram-context';

function callbackContext(data: string, answerCallbackQuery = vi.fn().mockResolvedValue(true)): TelegramContext {
  return {
    callbackQuery: { data },
    answerCallbackQuery,
  } as unknown as TelegramContext;
}

describe('homeCallbackAckMiddleware', () => {
  it.each([
    'ho',
    'h:AbCdEfGhIjKlMn_-:1:h',
    'rh:l:t',
    'rh:f:c',
    'rh:i:t',
    'rh:d:c',
    'rh:u:r',
  ])('acknowledges Home callback %s before continuing', async (data) => {
    let resolveAcknowledgement!: () => void;
    const acknowledgement = new Promise<void>((resolve) => { resolveAcknowledgement = resolve; });
    const answerCallbackQuery = vi.fn().mockReturnValue(acknowledgement);
    const ctx = callbackContext(data, answerCallbackQuery);
    const next = vi.fn().mockResolvedValue(undefined);

    const result = homeCallbackAckMiddleware(ctx, next);
    await Promise.resolve();

    expect(answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    resolveAcknowledgement();
    await result;

    expect(ctx.homeCallbackAcknowledged).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('continues after a Home acknowledgement failure', async () => {
    const answerCallbackQuery = vi.fn().mockRejectedValue(new Error('expired'));
    const ctx = callbackContext('ho', answerCallbackQuery);
    const next = vi.fn().mockResolvedValue(undefined);

    await homeCallbackAckMiddleware(ctx, next);

    expect(ctx.homeCallbackAcknowledged).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    'settings:locale:uk',
    'rh:l',
    'rh:f',
    'rh:i:x',
    'rh:drive:t',
    'rh:u:t:extra',
    'rh:x:t',
    'rh:f:c\n',
  ])('does not acknowledge unrelated or malformed callbacks: %s', async (data) => {
    const answerCallbackQuery = vi.fn().mockResolvedValue(true);
    const ctx = callbackContext(data, answerCallbackQuery);
    const next = vi.fn().mockResolvedValue(undefined);

    await homeCallbackAckMiddleware(ctx, next);

    expect(ctx.homeCallbackAcknowledged).toBeUndefined();
    expect(answerCallbackQuery).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

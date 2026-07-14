import { describe, expect, it, vi } from 'vitest';
import { HomeNavigationUseCase } from '../../../src/telegram/application/home-navigation.use-case';

const now = new Date('2030-01-01T00:00:00.000Z');
const active = {
  userId: 1, chatId: 2, messageId: 3, token: 'AbCdEfGhIjKlMn_-', revision: 1,
};

describe('HomeNavigationUseCase', () => {
  it.each([119_999, 120_000])('makes a pause confirmation live only before its exact two-minute expiry (%ims)', async (elapsed) => {
    const actions = { createPauseConfirmation: vi.fn().mockResolvedValue(undefined) };
    const useCase = new HomeNavigationUseCase(
      actions as never,
      { now: () => now } as never,
      { generate: () => '1234567890abcdef' } as never,
    );

    const result = await useCase.execute({
      active,
      role: 'user',
      view: { kind: 'pause-duration' },
      action: { kind: 'pause-hours', hours: 4 },
    });

    expect(result).toEqual({
      kind: 'render',
      view: { kind: 'pause-confirmation', hours: 4, receiptId: '1234567890abcdef' },
    });
    const receipt = actions.createPauseConfirmation.mock.calls[0][0];
    expect(receipt.expiresAt.getTime() - now.getTime()).toBe(120_000);
    expect(receipt.expiresAt.getTime() > now.getTime() + elapsed).toBe(elapsed === 119_999);
  });

  it('rejects a confirmation callback on a different view before inspecting receipts', async () => {
    const actions = { confirmPause: vi.fn() };
    const useCase = new HomeNavigationUseCase(
      actions as never,
      { now: () => now } as never,
      { generate: () => '1234567890abcdef' } as never,
    );

    await expect(useCase.execute({
      active,
      role: 'user',
      view: { kind: 'notifications' },
      action: { kind: 'confirm-pause', receiptId: '1234567890abcdef' },
    })).resolves.toEqual({ kind: 'recovery', reason: 'superseded' });
    expect(actions.confirmPause).not.toHaveBeenCalled();
  });

  it('confirms only the pause receipt encoded in its matching confirmation view', async () => {
    const actions = { confirmPause: vi.fn().mockResolvedValue({ kind: 'applied', expectedRevision: 1 }) };
    const useCase = new HomeNavigationUseCase(
      actions as never,
      { now: () => now } as never,
      { generate: () => '1234567890abcdef' } as never,
    );

    await expect(useCase.execute({
      active,
      role: 'user',
      view: { kind: 'pause-confirmation', hours: 4, receiptId: '1234567890abcdef' },
      action: { kind: 'confirm-pause', receiptId: '1234567890abcdef' },
    })).resolves.toEqual({ kind: 'render', view: { kind: 'notifications' } });
    expect(actions.confirmPause).toHaveBeenCalledWith({
      userId: 1, chatId: 2, token: active.token, id: '1234567890abcdef', hours: 4, now,
    });
  });
});

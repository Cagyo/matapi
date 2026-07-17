import { describe, expect, it, vi } from 'vitest';
import { HomeNavigationUseCase } from '../../../src/telegram/application/home-navigation.use-case';
import type { HomeView } from '../../../src/telegram/domain/home-session';

const now = new Date('2030-01-01T00:00:00.000Z');
const active = {
  userId: 1, chatId: 2, messageId: 3, token: 'AbCdEfGhIjKlMn_-', revision: 1,
};

describe('HomeNavigationUseCase', () => {
  it.each([
    [{ kind: 'sensors', page: 2, checking: false }, { kind: 'home', checking: false }],
    [{ kind: 'notifications' }, { kind: 'home', checking: false }],
    [{ kind: 'notification-targets', page: 3, targets: [] }, { kind: 'notifications' }],
    [{ kind: 'notification-target', page: 3, target: { kind: 'sensor', id: '123e4567-e89b-12d3-a456-426614174000' } }, { kind: 'notification-targets', page: 3, targets: [] }],
    [{ kind: 'pause-duration' }, { kind: 'notifications' }],
    [{ kind: 'pause-confirmation', hours: 4, receiptId: '1234567890abcdef' }, { kind: 'pause-duration' }],
    [{ kind: 'more' }, { kind: 'home', checking: false }],
    [{ kind: 'history' }, { kind: 'more' }],
    [{ kind: 'admin-tools' }, { kind: 'more' }],
    [{ kind: 'admin-sensor-setup' }, { kind: 'admin-tools' }],
    [{ kind: 'admin-storage' }, { kind: 'admin-tools' }],
    [{ kind: 'admin-system' }, { kind: 'admin-tools' }],
    [{ kind: 'admin-cleanup-threshold' }, { kind: 'admin-system' }],
    [{ kind: 'confirmation', action: 'cleanup', receiptId: '1234567890abcdef' }, { kind: 'admin-storage' }],
    [{ kind: 'confirmation', action: 'restart', receiptId: '1234567890abcdef' }, { kind: 'admin-system' }],
    [{ kind: 'cleanup-result', outcome: 'executed', threshold: 80 }, { kind: 'admin-storage' }],
  ] satisfies readonly [HomeView, HomeView][])('returns Back from %o to its immediate validated parent without effects', async (view, parent) => {
    const actions = {
      confirmPause: vi.fn(), undoPause: vi.fn(), setQuietHours: vi.fn(), undoQuietHours: vi.fn(),
      createPauseConfirmation: vi.fn(), createExternalConfirmation: vi.fn(), claimExternal: vi.fn(),
    };
    const useCase = new HomeNavigationUseCase(
      actions as never,
      { now: () => now },
      { generate: () => '1234567890abcdef' },
    );

    await expect(useCase.execute({ active, role: 'admin', view, action: { kind: 'back' } }))
      .resolves.toEqual({ kind: 'render', view: parent });
    for (const effect of Object.values(actions)) expect(effect).not.toHaveBeenCalled();
  });

  it('recovers from Back on Home without side effects', async () => {
    const actions = { createPauseConfirmation: vi.fn(), claimExternal: vi.fn() };
    const useCase = new HomeNavigationUseCase(
      actions as never,
      { now: () => now },
      { generate: () => '1234567890abcdef' },
    );

    await expect(useCase.execute({ active, role: 'user', view: { kind: 'home', checking: false }, action: { kind: 'back' } }))
      .resolves.toEqual({ kind: 'recovery', reason: 'superseded' });
    expect(actions.createPauseConfirmation).not.toHaveBeenCalled();
    expect(actions.claimExternal).not.toHaveBeenCalled();
  });

  it('opens Cleanup threshold only from System and applies threshold values only on that submenu', async () => {
    const actions = { createPauseConfirmation: vi.fn(), claimExternal: vi.fn() };
    const useCase = new HomeNavigationUseCase(
      actions as never,
      { now: () => now },
      { generate: () => '1234567890abcdef' },
    );

    await expect(useCase.execute({
      active,
      role: 'admin',
      view: { kind: 'admin-system' },
      action: { kind: 'admin-cleanup-threshold' },
    })).resolves.toEqual({ kind: 'render', view: { kind: 'admin-cleanup-threshold' } });
    await expect(useCase.execute({
      active,
      role: 'admin',
      view: { kind: 'admin-system' },
      action: { kind: 'auto-clean-threshold', value: 80 },
    })).resolves.toEqual({ kind: 'recovery', reason: 'superseded' });
    await expect(useCase.execute({
      active,
      role: 'admin',
      view: { kind: 'admin-cleanup-threshold' },
      action: { kind: 'auto-clean-threshold', value: 80 },
    })).resolves.toEqual({ kind: 'render', view: { kind: 'admin-cleanup-threshold' } });
  });

  it('starts the Camera external workflow only from a validated Home view', async () => {
    const useCase = new HomeNavigationUseCase(
      {} as never,
      { now: () => now },
      { generate: () => '1234567890abcdef' },
    );

    await expect(useCase.execute({
      active,
      role: 'user',
      view: { kind: 'home', checking: false },
      action: { kind: 'camera' },
    })).resolves.toEqual({ kind: 'external', destination: 'camera' });
    await expect(useCase.execute({
      active,
      role: 'user',
      view: { kind: 'more' },
      action: { kind: 'camera' },
    })).resolves.toEqual({ kind: 'recovery', reason: 'superseded' });
  });

  it('refreshes the already validated legacy view without changing its destination', async () => {
    const useCase = new HomeNavigationUseCase(
      {} as never,
      { now: () => now },
      { generate: () => '1234567890abcdef' },
    );
    const view: HomeView = { kind: 'sensors', page: 2, checking: false };

    await expect(useCase.execute({ active, role: 'user', view, action: { kind: 'refresh' } }))
      .resolves.toEqual({ kind: 'render', view });
  });

  it.each([119_999, 120_000])('makes a pause confirmation live only before its exact two-minute expiry (%ims)', async (elapsed) => {
    const actions = { createPauseConfirmation: vi.fn().mockResolvedValue(undefined) };
    const useCase = new HomeNavigationUseCase(
      actions as never,
      { now: () => now },
      { generate: () => '1234567890abcdef' },
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
      { now: () => now },
      { generate: () => '1234567890abcdef' },
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
      { now: () => now },
      { generate: () => '1234567890abcdef' },
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

  it('keeps a validated mutation effect-free until the workflow boundary explicitly executes it', async () => {
    const actions = { confirmPause: vi.fn().mockResolvedValue({ kind: 'applied', expectedRevision: 1 }) };
    const useCase = new HomeNavigationUseCase(
      actions as never,
      { now: () => now },
      { generate: () => '1234567890abcdef' },
    );
    const input = {
      active,
      role: 'user' as const,
      view: { kind: 'pause-confirmation', hours: 4 as const, receiptId: '1234567890abcdef' },
      action: { kind: 'confirm-pause' as const, receiptId: '1234567890abcdef' },
    };

    expect(useCase.route(input)).toEqual({ kind: 'effect' });
    expect(actions.confirmPause).not.toHaveBeenCalled();

    await expect(useCase.executeEffect(input)).resolves.toEqual({ kind: 'render', view: { kind: 'notifications' } });
    expect(actions.confirmPause).toHaveBeenCalledOnce();
  });
});

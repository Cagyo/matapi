import { describe, expect, it, vi } from 'vitest';
import { RestartConfirmationService } from '../../../src/telegram/application/restart-confirmation.service';
import { RESTART_REASON_KEY } from '../../../src/telegram/application/restart-system.use-case';
import { en } from '../../../src/locales/en';
import { SystemMetaRepositoryPort } from '../../../src/system/domain/ports/system-meta-repository.port';
import { DirectMessengerPort } from '../../../src/telegram/domain/ports/direct-messenger.port';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';

function makeMeta(seed: Record<string, string> = {}): SystemMetaRepositoryPort {
  const store = new Map(Object.entries(seed));
  return {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
  };
}

function admin(id: number, name: string) {
  return {
    telegramId: id,
    name,
    role: 'admin' as const,
    muted: false,
    quietStart: null,
    quietEnd: null,
    createdAt: null,
  };
}

function user(id: number, name: string) {
  return {
    telegramId: id,
    name,
    role: 'user' as const,
    muted: false,
    quietStart: null,
    quietEnd: null,
    createdAt: null,
  };
}

describe('RestartConfirmationService', () => {
  it('is a no-op when no restart reason flag is set', async () => {
    const dm: DirectMessengerPort = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new RestartConfirmationService(
      makeMeta(),
      new InMemoryUserRepository([admin(1, 'Ada')]),
      dm,
    );

    await service.run();

    expect(dm.send).not.toHaveBeenCalled();
  });

  it('notifies all admins on user_command restart and clears the flag', async () => {
    const meta = makeMeta({ [RESTART_REASON_KEY]: 'user_command' });
    const dm: DirectMessengerPort = { send: vi.fn().mockResolvedValue(undefined) };
    const users = new InMemoryUserRepository([
      admin(1, 'Ada'),
      admin(2, 'Bob'),
      user(3, 'Cal'),
    ]);
    const service = new RestartConfirmationService(meta, users, dm);

    await service.run();

    expect(dm.send).toHaveBeenCalledTimes(2);
    expect(dm.send).toHaveBeenCalledWith(1, en.ota.restartComplete);
    expect(dm.send).toHaveBeenCalledWith(2, en.ota.restartComplete);
    expect(await meta.get(RESTART_REASON_KEY)).toBeNull();
  });

  it('reports a successful OTA update with short commit hash', async () => {
    const meta = makeMeta({
      [RESTART_REASON_KEY]: 'ota_update',
      update_commit: 'abcdef1234567890',
    });
    const dm: DirectMessengerPort = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new RestartConfirmationService(
      meta,
      new InMemoryUserRepository([admin(1, 'Ada')]),
      dm,
    );

    await service.run();

    expect(dm.send).toHaveBeenCalledWith(1, en.ota.updateSuccess('abcdef1'));
  });

  it('reports a failed OTA update', async () => {
    const meta = makeMeta({ [RESTART_REASON_KEY]: 'ota_update_failed' });
    const dm: DirectMessengerPort = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new RestartConfirmationService(
      meta,
      new InMemoryUserRepository([admin(1, 'Ada')]),
      dm,
    );

    await service.run();

    expect(dm.send).toHaveBeenCalledWith(1, en.ota.updateFailed);
  });

  it('reports a rollback completion', async () => {
    const meta = makeMeta({
      [RESTART_REASON_KEY]: 'rollback',
      rollback_commit: '1234567abcdef',
    });
    const dm: DirectMessengerPort = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new RestartConfirmationService(
      meta,
      new InMemoryUserRepository([admin(1, 'Ada')]),
      dm,
    );

    await service.run();

    expect(dm.send).toHaveBeenCalledWith(1, en.ota.rollbackSuccess('1234567'));
  });
});

import { describe, expect, it } from 'vitest';
import { SetNotificationTargetMutedUseCase } from '../../../src/telegram/application/set-notification-target-muted.use-case';
import { NotificationTargetUnavailableError } from '../../../src/telegram/domain/errors/notification-target-unavailable.error';
import { InMemoryUserSensorMuteRepository } from '../../../src/telegram/infrastructure/in-memory-user-sensor-mute.repository';

describe('SetNotificationTargetMutedUseCase', () => {
  it('mutates only a currently enabled, typed target and is idempotent', async () => {
    const mutes = new InMemoryUserSensorMuteRepository();
    const target = { ref: { kind: 'camera' as const, id: 'same' }, name: 'Camera', kind: 'camera' as const, muted: false };
    const directory = { findEnabled: async () => target };
    const useCase = new SetNotificationTargetMutedUseCase(directory, mutes);

    await useCase.execute(7, target.ref, true);
    await useCase.execute(7, target.ref, true);
    expect(await mutes.isMuted(7, target.ref)).toBe(true);
    expect(await mutes.isMuted(7, { kind: 'sensor', id: 'same' })).toBe(false);
  });

  it('rejects a removed target rather than mutating a stale ID', async () => {
    const useCase = new SetNotificationTargetMutedUseCase({ findEnabled: async () => null }, new InMemoryUserSensorMuteRepository());
    await expect(useCase.execute(7, { kind: 'sensor', id: 'removed' }, true)).rejects.toBeInstanceOf(NotificationTargetUnavailableError);
  });
});

import { describe, expect, it } from 'vitest';
import { TelegramRecipientDirectoryAdapter } from '../../../src/telegram/infrastructure/telegram-recipient-directory.adapter';
import { SetNotificationTargetMutedUseCase } from '../../../src/telegram/application/set-notification-target-muted.use-case';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';
import { InMemoryUserSensorMuteRepository } from '../../../src/telegram/infrastructure/in-memory-user-sensor-mute.repository';
import { UserSensorMuteRepositoryPort } from '../../../src/telegram/domain/ports/user-sensor-mute-repository.port';
import { User } from '../../../src/telegram/domain/user.entity';

const noMutes: UserSensorMuteRepositoryPort = {
  isMuted: async () => false,
  mute: async () => undefined,
  unmute: async () => undefined,
  listForUser: async () => [],
  countForUser: async () => 0,
};

function seedUser(overrides: Partial<User> & Pick<User, 'telegramId'>): User {
  return {
    name: 'Ada',
    role: 'user',
    locale: 'en',
    muted: false,
    nonCriticalPausedUntil: null,
    notificationPauseRevision: 0,
    quietStart: null,
    quietEnd: null,
    createdAt: null,
    ...overrides,
  };
}

describe('TelegramRecipientDirectoryAdapter', () => {
  it('projects each user timed pause deadline into the recipient read model', async () => {
    const deadline = new Date('2030-01-01T04:00:00.000Z');
    const users = new InMemoryUserRepository([
      seedUser({ telegramId: 1, nonCriticalPausedUntil: deadline }),
      seedUser({ telegramId: 2 }),
    ]);
    const adapter = new TelegramRecipientDirectoryAdapter(users, noMutes);

    const recipients = await adapter.listRecipients();

    expect(recipients).toEqual([
      { telegramId: 1, muted: false, nonCriticalPausedUntil: deadline, quietStart: null, quietEnd: null },
      { telegramId: 2, muted: false, nonCriticalPausedUntil: null, quietStart: null, quietEnd: null },
    ]);
  });

  it('suppresses delivery after a sensor is muted through the typed notification target use case', async () => {
    const users = new InMemoryUserRepository([seedUser({ telegramId: 1 })]);
    const mutes = new InMemoryUserSensorMuteRepository();
    const target = {
      ref: { kind: 'sensor' as const, id: 'front-door' },
      name: 'Front door',
      kind: 'sensor' as const,
      muted: false,
    };
    const setMuted = new SetNotificationTargetMutedUseCase({ findEnabled: async () => target }, mutes);
    const adapter = new TelegramRecipientDirectoryAdapter(users, mutes);

    await setMuted.execute(1, target.ref, true);

    await expect(adapter.isSensorMuted(1, 'front-door')).resolves.toBe(true);
  });
});

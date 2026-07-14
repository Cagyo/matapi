import { describe, expect, it } from 'vitest';
import { TelegramRecipientDirectoryAdapter } from '../../../src/telegram/infrastructure/telegram-recipient-directory.adapter';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';
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
});

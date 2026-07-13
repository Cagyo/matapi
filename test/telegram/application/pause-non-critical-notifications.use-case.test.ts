import { describe, expect, it } from 'vitest';
import { PauseNonCriticalNotificationsUseCase } from '../../../src/telegram/application/pause-non-critical-notifications.use-case';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';
import { UserNotFoundError } from '../../../src/telegram/domain/errors/user-not-found.error';
import { LegacyNotificationPauseActiveError } from '../../../src/telegram/domain/errors/legacy-notification-pause-active.error';
import { PauseDurationHours } from '../../../src/telegram/domain/ports/notification-pause-repository.port';
import { ClockPort } from '../../../src/events/domain/ports/clock.port';
import { User } from '../../../src/telegram/domain/user.entity';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const clock: ClockPort = { now: () => NOW };

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

function setup(seed: User[] = []) {
  const repo = new InMemoryUserRepository(seed);
  const useCase = new PauseNonCriticalNotificationsUseCase(repo, clock);
  return { repo, useCase };
}

describe('PauseNonCriticalNotificationsUseCase', () => {
  it.each([
    [1, '2030-01-01T01:00:00.000Z'],
    [4, '2030-01-01T04:00:00.000Z'],
    [8, '2030-01-01T08:00:00.000Z'],
  ] as const)('pauses for %i hour(s) with an exact deadline', async (hours, iso) => {
    const { useCase } = setup([seedUser({ telegramId: 1 })]);

    const result = await useCase.execute(1, hours);

    expect(result.pausedUntil).toEqual(new Date(iso));
    expect(result.revision).toBe(1);
    expect(typeof result.receiptId).toBe('number');
  });

  it('rejects an unsupported duration', async () => {
    const { useCase } = setup([seedUser({ telegramId: 1 })]);

    await expect(
      useCase.execute(1, 3 as unknown as PauseDurationHours),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('rejects a missing user with UserNotFoundError', async () => {
    const { useCase } = setup();

    await expect(useCase.execute(404, 1)).rejects.toBeInstanceOf(
      UserNotFoundError,
    );
  });

  it('rejects a legacy-muted user with LegacyNotificationPauseActiveError', async () => {
    const { useCase } = setup([seedUser({ telegramId: 1, muted: true })]);

    await expect(useCase.execute(1, 1)).rejects.toBeInstanceOf(
      LegacyNotificationPauseActiveError,
    );
  });

  it('keeps two users isolated', async () => {
    const { repo, useCase } = setup([
      seedUser({ telegramId: 1 }),
      seedUser({ telegramId: 2 }),
    ]);

    await useCase.execute(1, 4);

    expect((await repo.findByTelegramId(1))?.nonCriticalPausedUntil).toEqual(
      new Date('2030-01-01T04:00:00.000Z'),
    );
    expect((await repo.findByTelegramId(2))?.nonCriticalPausedUntil).toBeNull();
    expect((await repo.findByTelegramId(2))?.notificationPauseRevision).toBe(0);
  });
});

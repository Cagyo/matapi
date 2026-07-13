import { describe, expect, it } from 'vitest';
import { ResumeNonCriticalNotificationsUseCase } from '../../../src/telegram/application/resume-non-critical-notifications.use-case';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';
import { UserNotFoundError } from '../../../src/telegram/domain/errors/user-not-found.error';
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
  const useCase = new ResumeNonCriticalNotificationsUseCase(repo, clock);
  return { repo, useCase };
}

describe('ResumeNonCriticalNotificationsUseCase', () => {
  it('clears both legacy mute and the timed pause for only the target user', async () => {
    const paused = {
      muted: true,
      nonCriticalPausedUntil: new Date('2030-01-01T04:00:00.000Z'),
      notificationPauseRevision: 3,
    };
    const { repo, useCase } = setup([
      seedUser({ telegramId: 1, ...paused }),
      seedUser({ telegramId: 2, ...paused }),
    ]);

    const result = await useCase.execute(1);

    expect(result.changed).toBe(true);
    expect(result.state.legacyMuted).toBe(false);
    expect(result.state.nonCriticalPausedUntil).toBeNull();
    expect(result.state.revision).toBe(4);

    const other = await repo.findByTelegramId(2);
    expect(other?.muted).toBe(true);
    expect(other?.nonCriticalPausedUntil).toEqual(new Date('2030-01-01T04:00:00.000Z'));
    expect(other?.notificationPauseRevision).toBe(3);
  });

  it('clears a present-but-expired deadline and reports changed:true', async () => {
    // Presence, not activity: a deadline already in the past is still clearable.
    const { useCase } = setup([
      seedUser({
        telegramId: 1,
        nonCriticalPausedUntil: new Date('2029-01-01T00:00:00.000Z'),
        notificationPauseRevision: 2,
      }),
    ]);

    const result = await useCase.execute(1);

    expect(result.changed).toBe(true);
    expect(result.state.nonCriticalPausedUntil).toBeNull();
    expect(result.state.revision).toBe(3);
  });

  it('reports changed:false without incrementing the revision when no pause state exists', async () => {
    const { useCase } = setup([
      seedUser({ telegramId: 1, notificationPauseRevision: 7 }),
    ]);

    const result = await useCase.execute(1);

    expect(result.changed).toBe(false);
    expect(result.state.revision).toBe(7);
  });

  it('rejects a missing user with UserNotFoundError', async () => {
    const { useCase } = setup();

    await expect(useCase.execute(404)).rejects.toBeInstanceOf(UserNotFoundError);
  });
});

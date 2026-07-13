import { describe, expect, it } from 'vitest';
import { SetQuietHoursUseCase } from '../../../src/telegram/application/set-quiet-hours.use-case';
import { InvalidQuietHoursError } from '../../../src/telegram/domain/errors/invalid-quiet-hours.error';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';

function seededRepo() {
  return new InMemoryUserRepository([
    {
      telegramId: 42,
      name: 'Ada',
      role: 'admin',
      locale: 'en',
      muted: false,
      nonCriticalPausedUntil: null,
      notificationPauseRevision: 0,
      quietStart: null,
      quietEnd: null,
      createdAt: null,
    },
  ]);
}

describe('SetQuietHoursUseCase', () => {
  it('persists a range and returns it', async () => {
    const users = seededRepo();
    const useCase = new SetQuietHoursUseCase(users);

    const result = await useCase.execute(42, '23:00-07:00');

    expect(result).toEqual({ start: '23:00', end: '07:00' });
    const persisted = await users.findByTelegramId(42);
    expect(persisted).toMatchObject({
      quietStart: '23:00',
      quietEnd: '07:00',
    });
  });

  it('disables quiet hours when given "off"', async () => {
    const users = seededRepo();
    await users.setQuietHours(42, '23:00', '07:00');
    const useCase = new SetQuietHoursUseCase(users);

    const result = await useCase.execute(42, 'off');

    expect(result).toEqual({ start: null, end: null });
    const persisted = await users.findByTelegramId(42);
    expect(persisted).toMatchObject({ quietStart: null, quietEnd: null });
  });

  it('rejects invalid format with InvalidQuietHoursError', async () => {
    const useCase = new SetQuietHoursUseCase(seededRepo());
    await expect(useCase.execute(42, 'lunchtime')).rejects.toBeInstanceOf(
      InvalidQuietHoursError,
    );
  });
});

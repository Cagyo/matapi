import { describe, expect, it } from 'vitest';
import { CompareAndSetQuietHoursUseCase } from '../../../src/telegram/application/compare-and-set-quiet-hours.use-case';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';

describe('CompareAndSetQuietHoursUseCase', () => {
  it('increments the pause revision only for an actual quiet-hours change', async () => {
    const users = new InMemoryUserRepository([{ telegramId: 1, name: 'Ada', role: 'user', locale: 'en', muted: false, nonCriticalPausedUntil: null, notificationPauseRevision: 0, quietStart: null, quietEnd: null, createdAt: null }]);
    const useCase = new CompareAndSetQuietHoursUseCase(users);

    await expect(useCase.execute({ userId: 1, expectedRevision: 0, start: null, end: null, now: new Date() })).resolves.toMatchObject({ kind: 'applied', changed: false, state: { revision: 0 } });
    await expect(useCase.execute({ userId: 1, expectedRevision: 0, start: '22:00', end: '07:00', now: new Date() })).resolves.toMatchObject({ kind: 'applied', changed: true, state: { revision: 1 } });
  });
});

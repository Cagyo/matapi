import { describe, expect, it } from 'vitest';
import { ClaimAdminUseCase } from '../../../src/telegram/application/claim-admin.use-case';
import { AdminAlreadyClaimedError } from '../../../src/telegram/domain/errors/admin-already-claimed.error';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';
import { ClockPort } from '../../../src/events/domain/ports/clock.port';

function fixedClock(now: Date): ClockPort {
  return { now: () => now };
}

describe('ClaimAdminUseCase', () => {
  const clock = fixedClock(new Date('2030-01-01T00:00:00.000Z'));

  it('promotes the first sender to admin', async () => {
    const users = new InMemoryUserRepository();
    const useCase = new ClaimAdminUseCase(users, clock);

    const admin = await useCase.execute({ telegramId: 1001, name: 'Ada' });

    expect(admin).toEqual({
      telegramId: 1001,
      name: 'Ada',
      role: 'admin',
      muted: false,
      quietStart: null,
      quietEnd: null,
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    expect(await users.countAdmins()).toBe(1);
  });

  it('rejects every subsequent claim once an admin exists', async () => {
    const users = new InMemoryUserRepository([
      {
        telegramId: 1001,
        name: 'Ada',
        role: 'admin',
        createdAt: new Date('2029-01-01T00:00:00.000Z'),
      },
    ]);
    const useCase = new ClaimAdminUseCase(users, clock);

    await expect(
      useCase.execute({ telegramId: 1002, name: 'Linus' }),
    ).rejects.toBeInstanceOf(AdminAlreadyClaimedError);

    expect(await users.countAdmins()).toBe(1);
  });

  it('lets only one of two concurrent claims win', async () => {
    const users = new InMemoryUserRepository();
    const useCase = new ClaimAdminUseCase(users, clock);

    const results = await Promise.allSettled([
      useCase.execute({ telegramId: 1, name: 'A' }),
      useCase.execute({ telegramId: 2, name: 'B' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await users.countAdmins()).toBe(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { ClaimAdminUseCase } from '../../../src/telegram/application/claim-admin.use-case';
import { DemoteUserUseCase } from '../../../src/telegram/application/demote-user.use-case';
import { ResolveUserTargetUseCase } from '../../../src/telegram/application/resolve-user-target.use-case';
import { AdminAlreadyClaimedError } from '../../../src/telegram/domain/errors/admin-already-claimed.error';
import { AdminClaimNotConfiguredError } from '../../../src/telegram/domain/errors/admin-claim-not-configured.error';
import { InvalidAdminClaimTokenError } from '../../../src/telegram/domain/errors/invalid-admin-claim-token.error';
import { LastAdminDemotionError } from '../../../src/telegram/domain/errors/last-admin-demotion.error';
import { AdminClaimCredentialPort } from '../../../src/telegram/domain/ports/admin-claim-credential.port';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';
import { ClockPort } from '../../../src/events/domain/ports/clock.port';

function fixedClock(now: Date): ClockPort {
  return { now: () => now };
}

function claimCredential(expected: string | null): AdminClaimCredentialPort {
  return {
    isConfigured: () => expected !== null,
    verify: (candidate: string) => expected !== null && candidate === expected,
  };
}

describe('ClaimAdminUseCase', () => {
  const clock = fixedClock(new Date('2030-01-01T00:00:00.000Z'));

  it('promotes the first sender to admin', async () => {
    const users = new InMemoryUserRepository();
    const useCase = new ClaimAdminUseCase(
      users,
      clock,
      claimCredential('owner-token'),
    );

    const admin = await useCase.execute({
      telegramId: 1001,
      name: 'Ada',
      token: 'owner-token',
    });

    expect(admin).toEqual({
      telegramId: 1001,
      name: 'Ada',
      role: 'admin',
      locale: 'en',
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
        locale: 'en',
        createdAt: new Date('2029-01-01T00:00:00.000Z'),
      },
    ]);
    const useCase = new ClaimAdminUseCase(
      users,
      clock,
      claimCredential('owner-token'),
    );

    await expect(
      useCase.execute({
        telegramId: 1002,
        name: 'Linus',
        token: 'owner-token',
      }),
    ).rejects.toBeInstanceOf(AdminAlreadyClaimedError);

    expect(await users.countAdmins()).toBe(1);
  });

  it('keeps the claim token unusable after rejecting final-admin demotion', async () => {
    const users = new InMemoryUserRepository([
      {
        telegramId: 1001,
        name: 'Ada',
        role: 'admin',
        locale: 'en',
        createdAt: new Date('2029-01-01T00:00:00.000Z'),
      },
    ]);
    const demote = new DemoteUserUseCase(
      users,
      new ResolveUserTargetUseCase(users),
    );
    const claim = new ClaimAdminUseCase(
      users,
      clock,
      claimCredential('owner-token'),
    );

    await expect(demote.execute('Ada')).rejects.toBeInstanceOf(
      LastAdminDemotionError,
    );
    await expect(
      claim.execute({
        telegramId: 1002,
        name: 'Linus',
        token: 'owner-token',
      }),
    ).rejects.toBeInstanceOf(AdminAlreadyClaimedError);
  });

  it('rejects an existing admin before checking the claim credential', async () => {
    const users = new InMemoryUserRepository([
      {
        telegramId: 1001,
        name: 'Ada',
        role: 'admin',
        locale: 'en',
        createdAt: new Date('2029-01-01T00:00:00.000Z'),
      },
    ]);
    const isConfigured = vi.fn(() => false);
    const verify = vi.fn(() => false);
    const credential: AdminClaimCredentialPort = { isConfigured, verify };
    const useCase = new ClaimAdminUseCase(users, clock, credential);

    await expect(
      useCase.execute({ telegramId: 1002, name: 'Linus', token: 'wrong-token' }),
    ).rejects.toBeInstanceOf(AdminAlreadyClaimedError);

    expect(isConfigured).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('lets only one of two concurrent claims win', async () => {
    const users = new InMemoryUserRepository();
    const useCase = new ClaimAdminUseCase(
      users,
      clock,
      claimCredential('owner-token'),
    );

    const results = await Promise.allSettled([
      useCase.execute({ telegramId: 1, name: 'A', token: 'owner-token' }),
      useCase.execute({ telegramId: 2, name: 'B', token: 'owner-token' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof AdminAlreadyClaimedError,
      ),
    ).toHaveLength(1);
    expect(await users.countAdmins()).toBe(1);
  });

  it('rejects an unconfigured credential without creating an admin', async () => {
    const users = new InMemoryUserRepository();
    const useCase = new ClaimAdminUseCase(users, clock, claimCredential(null));

    await expect(
      useCase.execute({ telegramId: 1001, name: 'Ada', token: 'owner-token' }),
    ).rejects.toBeInstanceOf(AdminClaimNotConfiguredError);

    expect(await users.countAdmins()).toBe(0);
  });

  it('rejects an invalid credential token without creating an admin', async () => {
    const users = new InMemoryUserRepository();
    const useCase = new ClaimAdminUseCase(
      users,
      clock,
      claimCredential('owner-token'),
    );

    await expect(
      useCase.execute({ telegramId: 1001, name: 'Ada', token: 'wrong-token' }),
    ).rejects.toBeInstanceOf(InvalidAdminClaimTokenError);

    expect(await users.countAdmins()).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { RegisterUserUseCase } from '../../../src/telegram/application/register-user.use-case';
import { AlreadyRegisteredError } from '../../../src/telegram/domain/errors/already-registered.error';
import { InvalidInviteCodeError } from '../../../src/telegram/domain/errors/invalid-invite-code.error';
import { InviteCodeUsedError } from '../../../src/telegram/domain/errors/invite-code-used.error';
import { InMemoryInviteCodeRepository } from '../../../src/telegram/infrastructure/in-memory-invite-code.repository';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';
import { ClockPort } from '../../../src/events/domain/ports/clock.port';

const fixedClock: ClockPort = {
  now: () => new Date('2030-01-01T00:00:00.000Z'),
};

function setup() {
  const users = new InMemoryUserRepository();
  const invites = new InMemoryInviteCodeRepository([
    {
      code: 'GOODCODE',
      role: 'user',
      createdBy: 1001,
      usedBy: null,
      createdAt: new Date('2029-12-31T00:00:00.000Z'),
      usedAt: null,
    },
  ]);
  const useCase = new RegisterUserUseCase(users, invites, fixedClock);
  return { users, invites, useCase };
}

describe('RegisterUserUseCase', () => {
  it('creates a user with the invite role and marks the code used', async () => {
    const { users, invites, useCase } = setup();

    const result = await useCase.execute({
      telegramId: 2002,
      name: 'Alex',
      code: 'GOODCODE',
    });

    expect(result.user).toMatchObject({
      telegramId: 2002,
      name: 'Alex',
      role: 'user',
    });
    expect(result.invitedBy).toBe(1001);
    expect(await users.findByTelegramId(2002)).not.toBeNull();
    const code = await invites.findByCode('GOODCODE');
    expect(code?.usedBy).toBe(2002);
    expect(code?.usedAt).toEqual(new Date('2030-01-01T00:00:00.000Z'));
  });

  it('rejects an unknown code', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute({ telegramId: 2002, name: 'Alex', code: 'NOPE' }),
    ).rejects.toBeInstanceOf(InvalidInviteCodeError);
  });

  it('rejects an already-used code', async () => {
    const { invites, useCase } = setup();
    await invites.markUsed('GOODCODE', 9999, new Date());
    await expect(
      useCase.execute({ telegramId: 2002, name: 'Alex', code: 'GOODCODE' }),
    ).rejects.toBeInstanceOf(InviteCodeUsedError);
  });

  it('rejects when the user is already registered', async () => {
    const { users, useCase } = setup();
    await users.createUser({
      telegramId: 2002,
      name: 'Alex',
      role: 'user',
      createdAt: new Date(),
    });
    await expect(
      useCase.execute({ telegramId: 2002, name: 'Alex', code: 'GOODCODE' }),
    ).rejects.toBeInstanceOf(AlreadyRegisteredError);
  });
});

import { describe, expect, it } from 'vitest';
import { InviteUseCase } from '../../../src/telegram/application/invite.use-case';
import { InMemoryInviteCodeRepository } from '../../../src/telegram/infrastructure/in-memory-invite-code.repository';
import { ClockPort } from '../../../src/events/domain/ports/clock.port';

const fixedClock: ClockPort = {
  now: () => new Date('2030-01-01T00:00:00.000Z'),
};

describe('InviteUseCase', () => {
  it('issues a new invite code with default user role', async () => {
    const invites = new InMemoryInviteCodeRepository();
    const useCase = new InviteUseCase(invites, fixedClock, () => 'ABCDEFGH');

    const invite = await useCase.execute({ invitedBy: 1001 });

    expect(invite).toMatchObject({
      code: 'ABCDEFGH',
      role: 'user',
      createdBy: 1001,
      usedBy: null,
      usedAt: null,
    });
    expect(await invites.findByCode('ABCDEFGH')).not.toBeNull();
  });

  it('retries on code collision', async () => {
    const invites = new InMemoryInviteCodeRepository([
      {
        code: 'ABCDEFGH',
        role: 'user',
        createdBy: 1,
        usedBy: null,
        createdAt: new Date('2029-01-01T00:00:00.000Z'),
        usedAt: null,
      },
    ]);
    const codes = ['ABCDEFGH', 'NEWCODE1'];
    let i = 0;
    const useCase = new InviteUseCase(invites, fixedClock, () => codes[i++]);

    const invite = await useCase.execute({ invitedBy: 1001 });
    expect(invite.code).toBe('NEWCODE1');
  });

  it('throws when every attempt collides', async () => {
    const invites = new InMemoryInviteCodeRepository([
      {
        code: 'X',
        role: 'user',
        createdBy: 1,
        usedBy: null,
        createdAt: null,
        usedAt: null,
      },
    ]);
    const useCase = new InviteUseCase(invites, fixedClock, () => 'X');
    await expect(useCase.execute({ invitedBy: 1001 })).rejects.toThrow(
      /collision/,
    );
  });
});

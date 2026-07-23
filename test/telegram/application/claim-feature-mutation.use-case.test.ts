import { describe, expect, it } from 'vitest';
import { ClaimFeatureMutationUseCase } from '../../../src/telegram/application/claim-feature-mutation.use-case';
import { BeginWorkflowReturnUseCase } from '../../../src/telegram/application/begin-workflow-return.use-case';
import { InMemoryHomeActionRepository } from '../../../src/telegram/infrastructure/in-memory-home-action.repository';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';

const now = new Date('2030-01-01T00:00:00.000Z');
const clock = { now: () => now };

describe('ClaimFeatureMutationUseCase', () => {
  it('claims an exact pending feature mutation using only the receipt authority', async () => {
    const users = new InMemoryUserRepository([{
      telegramId: 11, name: 'Admin', role: 'admin', locale: 'en', muted: false,
      nonCriticalPausedUntil: null, notificationPauseRevision: 0,
      quietStart: null, quietEnd: null, createdAt: now,
    }]);
    const actions = new InMemoryHomeActionRepository(users);
    const begin = new BeginWorkflowReturnUseCase(actions, { generate: () => 'AbCdEf0123_-xyZ9' }, clock);
    const created = await begin.execute({
      userId: 11,
      chatId: 22,
      workflow: 'feature',
      origin: { kind: 'home', checking: false },
      originSource: 'natural-parent',
      sessionToken: null,
      operation: {
        kind: 'feature-mutation', feature: 'digital', action: 'enable',
        expectedInstalled: true, expectedEnabled: false, expectedAttentionReason: null,
      },
    });
    const useCase = new ClaimFeatureMutationUseCase(actions, clock);

    await expect(useCase.execute({ userId: 11, chatId: 22, id: created.receipt.id }))
      .resolves.toMatchObject({
        kind: 'claimed',
        operation: { kind: 'feature-mutation', feature: 'digital', action: 'enable' },
        receipt: { id: created.receipt.id, status: 'executing' },
      });
  });

  it('returns unauthorized after an admin is demoted without claiming the receipt', async () => {
    const users = new InMemoryUserRepository([{
      telegramId: 11, name: 'Admin', role: 'admin', locale: 'en', muted: false,
      nonCriticalPausedUntil: null, notificationPauseRevision: 0,
      quietStart: null, quietEnd: null, createdAt: now,
    }]);
    const actions = new InMemoryHomeActionRepository(users);
    const begin = new BeginWorkflowReturnUseCase(actions, { generate: () => 'ZyXwVu9876_-tsR5' }, clock);
    const created = await begin.execute({
      userId: 11, chatId: 22, workflow: 'feature', origin: { kind: 'home', checking: false },
      originSource: 'natural-parent', sessionToken: null,
      operation: {
        kind: 'feature-mutation', feature: 'digital', action: 'enable',
        expectedInstalled: true, expectedEnabled: false, expectedAttentionReason: null,
      },
    });
    await users.updateRole(11, 'user');
    const useCase = new ClaimFeatureMutationUseCase(actions, clock);

    await expect(useCase.execute({ userId: 11, chatId: 22, id: created.receipt.id }))
      .resolves.toEqual({ kind: 'unauthorized' });
    await expect(actions.claimWorkflowReturn({ userId: 11, chatId: 22, id: created.receipt.id, now }))
      .resolves.toMatchObject({ kind: 'claimed' });
  });
});

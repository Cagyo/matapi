import { describe, expect, it } from 'vitest';
import { GetNotificationScreenUseCase } from '../../../src/telegram/application/get-notification-screen.use-case';

describe('GetNotificationScreenUseCase', () => {
  it('projects persisted notification settings and only current undo receipts for the chat', async () => {
    const receipt = { id: 'abcdefghijklmnop', userId: 7, chatId: 70, kind: 'undo-non-critical-pause' as const, sessionToken: null, status: 'pending' as const, expiresAt: new Date('2030-01-01T01:00:00Z'), payload: { foundationReceiptId: 1, expectedRevision: 2 } };
    const useCase = new GetNotificationScreenUseCase(
      { findByTelegramId: async () => ({ muted: true, nonCriticalPausedUntil: new Date('2030-01-01T02:00:00Z'), quietStart: '22:00', quietEnd: '07:00' }) },
      { listEnabled: async () => [{ muted: true }, { muted: false }] },
      { findCurrentUndo: async (input: { kind: string }) => input.kind === 'undo-non-critical-pause' ? receipt : null },
      { now: () => new Date('2030-01-01T00:00:00Z') },
    );
    await expect(useCase.execute({ userId: 7, chatId: 70 })).resolves.toEqual({ legacyMuted: true, timedPauseUntil: new Date('2030-01-01T02:00:00Z'), quietStart: '22:00', quietEnd: '07:00', mutedTargetCount: 1, undoPause: receipt, undoQuietHours: null });
  });
});

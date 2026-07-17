import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { HealthHandler } from '../../../src/telegram/interfaces/health.handler';

const receipt = {
  id: 'abcdefghijklmnop', userId: 42, chatId: 42, kind: 'workflow-return',
  sessionToken: null, status: 'pending', expiresAt: new Date('2030-01-02T00:00:00.000Z'),
  payload: { workflow: 'health', phase: 'cancellable', originSource: 'natural-parent', origin: { kind: 'admin-system' } },
};

describe('HealthHandler contextual workflow', () => {
  it('uses the direct System parent and sends a health result before completion', async () => {
    const events: string[] = [];
    const workflows = { begin: vi.fn().mockResolvedValue(receipt) };
    const navigation = { complete: vi.fn(async (_ctx, _launch, presentation) => {
      await presentation.deliver();
      events.push('restore');
    }) };
    const handler = new HealthHandler(
      { collect: vi.fn().mockResolvedValue({ diskUsedBytes: 1, diskTotalBytes: 2, cpuTempC: null, memoryUsedBytes: 1, memoryTotalBytes: 2, uptimeSec: 1, dbSizeBytes: 1 }) },
      { listEnabled: vi.fn().mockResolvedValue([]) },
      { probe: vi.fn().mockResolvedValue([]) },
      { getLastUpdateAt: vi.fn().mockReturnValue(null) },
      {} as never,
      workflows as never,
      navigation as never,
    );
    const ctx = {
      from: { id: 42 }, chat: { id: 42, type: 'private' },
      localeState: { locale: 'en', catalog: catalogFor('en'), user: { telegramId: 42, role: 'admin' } },
      reply: vi.fn(async () => { events.push('result'); }),
    };

    await handler.handleCommand(ctx as never);

    expect(workflows.begin).toHaveBeenCalledWith(ctx, 'health', { source: 'natural-parent' });
    expect(events).toEqual(['result', 'restore']);
  });
});

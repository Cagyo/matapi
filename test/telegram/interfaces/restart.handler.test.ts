import { describe, expect, it, vi } from 'vitest';
import { RestartHandler } from '../../../src/telegram/interfaces/restart.handler';

describe('RestartHandler contextual workflow', () => {
  it('marks its system restart receipt running before invoking the irreversible restart', async () => {
    const events: string[] = [];
    const receipt = {
      id: 'abcdefghijklmnop',
      userId: 42,
      chatId: 42,
      kind: 'workflow-return',
      status: 'pending',
      sessionToken: null,
      expiresAt: new Date('2030-01-02T00:00:00.000Z'),
      payload: {
        workflow: 'system-restart',
        phase: 'cancellable',
        originSource: 'natural-parent',
        origin: { kind: 'admin-system' },
      },
    };
    const workflows = {
      begin: vi.fn(async () => {
        events.push('begin');
        return receipt;
      }),
      markRunning: vi.fn(async () => {
        events.push('running');
        return true;
      }),
    };
    const restart = { execute: vi.fn(async () => { events.push('restart'); }) };
    const handler = new RestartHandler(restart as never, {} as never, workflows as never);
    const ctx = {
      from: { id: 42 },
      chat: { id: 42, type: 'private' },
      localeState: { catalog: { ota: { restarting: 'Restarting…' } } },
      reply: vi.fn(async () => { events.push('reply'); }),
    };

    await handler.handleCommand(ctx as never);

    expect(workflows.begin).toHaveBeenCalledWith(ctx, 'system-restart', { source: 'natural-parent' });
    expect(events).toEqual(['begin', 'running', 'reply', 'restart']);
  });
});

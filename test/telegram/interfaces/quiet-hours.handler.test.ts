import { describe, expect, it, vi } from 'vitest';
import { QuietHoursHandler } from '../../../src/telegram/interfaces/quiet-hours.handler';
import { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';

describe('QuietHoursHandler', () => {
  it('uses explicit legacy-menu callbacks when /quiet_hours opens preset controls', async () => {
    const handler = new QuietHoursHandler(
      { execute: vi.fn() } as any,
      { registered: vi.fn() } as unknown as RoleMiddleware,
    );
    const commands: Record<string, (ctx: any) => Promise<void>> = {};
    handler.register({ command: vi.fn((name, middleware, fn) => { commands[name] = fn ?? middleware; }) } as any);
    const reply = vi.fn().mockResolvedValue(undefined);

    await commands.quiet_hours({ from: { id: 100 }, match: '', reply });

    const keyboard = JSON.stringify(reply.mock.calls[0][1].reply_markup);
    expect(keyboard).toContain('legacy-menu:act:quiet:22:00-07:00');
    expect(keyboard).not.toContain('"callback_data":"menu:');
  });
});

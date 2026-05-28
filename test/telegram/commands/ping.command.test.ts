import { Bot, Context } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { en } from '../../../src/locales/en';
import { PingCommand } from '../../../src/telegram/commands/ping.command';
import { RoleGuard } from '../../../src/telegram/guards/role.guard';

describe('PingCommand', () => {
  it('registers /ping behind the registered-user guard', async () => {
    const guard = { registered: vi.fn() } as unknown as RoleGuard;
    const bot = { command: vi.fn() } as unknown as Bot & {
      command: ReturnType<typeof vi.fn>;
    };
    const reply = vi.fn().mockResolvedValue(undefined);

    new PingCommand(guard).register(bot);
    const handler = bot.command.mock.calls[0][2] as (ctx: Context) => Promise<void>;
    await handler({ reply } as unknown as Context);

    expect(bot.command).toHaveBeenCalledWith('ping', guard.registered, expect.any(Function));
    expect(reply).toHaveBeenCalledWith(en.ping.pong);
  });
});
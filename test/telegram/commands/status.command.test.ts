import { Bot, Context } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sensors } from '../../../src/database/schema';
import { en } from '../../../src/locales/en';
import { StatusCommand } from '../../../src/telegram/commands/status.command';
import { RoleGuard } from '../../../src/telegram/guards/role.guard';
import {
  createTestDatabase,
  TestDatabaseContext,
} from '../../helpers/database';

function makeBot() {
  return { command: vi.fn() } as unknown as Bot & {
    command: ReturnType<typeof vi.fn>;
  };
}

describe('StatusCommand', () => {
  let context: TestDatabaseContext;
  const guard = { registered: vi.fn() } as unknown as RoleGuard;

  beforeEach(() => {
    context = createTestDatabase();
  });

  afterEach(() => {
    context.close();
  });

  it('replies with the empty state when no sensors are enabled', async () => {
    const bot = makeBot();
    const reply = vi.fn().mockResolvedValue(undefined);
    new StatusCommand(context.appDb, guard).register(bot);

    const handler = bot.command.mock.calls[0][2] as (ctx: Context) => Promise<void>;
    await handler({ reply } as unknown as Context);

    expect(reply).toHaveBeenCalledWith(en.status.none);
  });

  it('lists only enabled sensors with their latest reading time', async () => {
    const lastValueAt = new Date('2030-01-01T00:00:00.000Z');
    context.db
      .insert(sensors)
      .values([
        {
          id: 'front_door',
          name: 'Front door',
          type: 'digital',
          enabled: true,
          config: { pin: 17 },
          lastValue: 'open',
          lastValueAt,
        },
        {
          id: 'garage',
          name: 'Garage',
          type: 'digital',
          enabled: false,
          config: { pin: 27 },
          lastValue: 'closed',
          lastValueAt,
        },
      ])
      .run();
    const bot = makeBot();
    const reply = vi.fn().mockResolvedValue(undefined);
    new StatusCommand(context.appDb, guard).register(bot);

    const handler = bot.command.mock.calls[0][2] as (ctx: Context) => Promise<void>;
    await handler({ reply } as unknown as Context);

    expect(reply).toHaveBeenCalledWith(
      `${en.status.header}\n${en.status.line('Front door', 'open', lastValueAt.toISOString())}`,
    );
  });
});
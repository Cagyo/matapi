import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { ExportConfigHandler } from '../../../src/telegram/interfaces/export-config.handler';

const receipt = {
  id: 'abcdefghijklmnop', userId: 42, chatId: 42, kind: 'workflow-return',
  sessionToken: null, status: 'pending', expiresAt: new Date('2030-01-02T00:00:00.000Z'),
  payload: { workflow: 'sensor-export', phase: 'cancellable', originSource: 'natural-parent', origin: { kind: 'admin-sensor-setup' } },
};

function setup() {
  const events: string[] = [];
  const exportConfig = { execute: vi.fn() };
  const workflows = { begin: vi.fn(async () => receipt) };
  const navigation = {
    complete: vi.fn(async (_ctx, _launch, presentation) => {
      await presentation.deliver();
      events.push('restore-after-result');
    }),
  };
  const handler = new ExportConfigHandler(exportConfig as never, {} as never, workflows as never, navigation as never);
  const commands: Record<string, (ctx: object) => Promise<void>> = {};
  handler.register({ command: vi.fn((name, _guard, fn) => { commands[name] = fn; }) } as never);
  const ctx = {
    from: { id: 42 }, chat: { id: 42, type: 'private' },
    localeState: { locale: 'en', catalog: catalogFor('en'), user: { telegramId: 42, role: 'admin' } },
    reply: vi.fn().mockResolvedValue(undefined),
    replyWithDocument: vi.fn(async () => { events.push('result'); }),
  };
  return { commands, ctx, exportConfig, workflows, navigation, events, handler };
}

describe('ExportConfigHandler', () => {
  it('begins the direct Sensor setup workflow and sends the document before restoration', async () => {
    const { commands, ctx, exportConfig, workflows, events } = setup();
    exportConfig.execute.mockResolvedValue({ yaml: 'sensors: []\n', filename: 'home-worker-config.yml' });

    await commands.export_config(ctx);

    expect(workflows.begin).toHaveBeenCalledWith(ctx, 'sensor-export', { source: 'natural-parent' });
    expect(ctx.replyWithDocument).toHaveBeenCalledOnce();
    expect(events).toEqual(['result', 'restore-after-result']);
  });

  it('uses the captured receipt without starting a second workflow and delivers a failure first', async () => {
    const { ctx, exportConfig, workflows, navigation, events, handler } = setup();
    exportConfig.execute.mockRejectedValue(new Error('disk unavailable'));

    await handler.handleCommand(ctx as never, { receipt } as never);

    expect(workflows.begin).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(catalogFor('en').exportConfig.failed);
    expect(navigation.complete).toHaveBeenCalledOnce();
    expect(events).toEqual(['restore-after-result']);
  });
});

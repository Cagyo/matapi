import { describe, expect, it, vi } from 'vitest';
import { InputFile } from 'grammy';
import { catalogFor } from '../../../src/locales';
import { en } from '../../../src/locales/en';
import { ExportConfigHandler } from '../../../src/telegram/interfaces/export-config.handler';

function createSetup() {
  const exportConfig = { execute: vi.fn() };
  const guard = { adminOnly: vi.fn() };
  const handler = new ExportConfigHandler(exportConfig as never, guard as never);
  const commands: Record<string, (ctx: Record<string, unknown>) => Promise<void>> = {};
  handler.register({
    command: vi.fn((name: string, _guard: unknown, command: (ctx: Record<string, unknown>) => Promise<void>) => {
      commands[name] = command;
    }),
  } as never);
  return { commands, exportConfig };
}

function ctxFor(locale: 'en' | 'uk') {
  return {
    localeState: { catalog: catalogFor(locale) },
    reply: vi.fn().mockResolvedValue(true),
    replyWithDocument: vi.fn().mockResolvedValue(true),
  };
}

describe('ExportConfigHandler', () => {
  it('adds terminal Home to the exported document', async () => {
    const { commands, exportConfig } = createSetup();
    const command = commands.export_config;
    const ctx = ctxFor('uk');
    exportConfig.execute.mockResolvedValue({
      yaml: 'sensors: []\n',
      filename: 'home-worker-config.yml',
    });

    await command(ctx);

    expect(ctx.replyWithDocument).toHaveBeenCalledWith(
      expect.any(InputFile),
      expect.objectContaining({
        caption: en.exportConfig.caption,
        reply_markup: expect.anything(),
      }),
    );
    expect(JSON.stringify(ctx.replyWithDocument.mock.calls[0][1].reply_markup)).toContain('rh:f:t');
    expect(JSON.stringify(ctx.replyWithDocument.mock.calls[0][1].reply_markup)).toContain('🏠 Дім');
  });

  it('adds terminal Home to export failures', async () => {
    const { commands, exportConfig } = createSetup();
    const ctx = ctxFor('uk');
    exportConfig.execute.mockRejectedValueOnce(new Error('disk unavailable'));

    await commands.export_config(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(
      en.exportConfig.failed,
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(JSON.stringify(ctx.reply.mock.calls[0][1].reply_markup)).toContain('rh:f:t');
    expect(JSON.stringify(ctx.reply.mock.calls[0][1].reply_markup)).toContain('🏠 Дім');
  });
});

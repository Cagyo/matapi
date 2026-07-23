import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { FeatureHandler } from '../../../src/telegram/interfaces/feature.handler';

const receipt = {
  id: 'abcdefghijklmnop', userId: 7, chatId: 7, kind: 'workflow-return' as const,
  sessionToken: null, status: 'pending' as const, expiresAt: new Date('2030-01-01'),
  payload: { workflow: 'feature' as const, phase: 'cancellable' as const, originSource: 'natural-parent' as const, origin: { kind: 'more' as const }, deliveryStage: 'pending' as const },
};

function setup() {
  const list = { execute: vi.fn().mockResolvedValue([
    { name: 'digital', installed: false, enabled: false, ready: false, busy: false, attentionReason: null, display: 'not-installed', action: 'install' },
    { name: 'uart', installed: true, enabled: false, ready: true, busy: false, attentionReason: null, display: 'installed-off', action: 'enable' },
    { name: 'zigbee', installed: true, enabled: true, ready: true, busy: false, attentionReason: null, display: 'enabled', action: 'disable' },
    { name: 'motion', installed: false, enabled: false, ready: false, busy: false, attentionReason: null, display: 'not-installed', action: 'install' },
    { name: 'rtsp', installed: false, enabled: false, ready: false, busy: false, attentionReason: null, display: 'not-installed', action: 'install' },
  ]) };
  const handler = new FeatureHandler(
    list as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, { begin: vi.fn().mockResolvedValue(receipt), completeHeadless: vi.fn() } as never,
    {} as never, {} as never, { register: vi.fn() } as never, {} as never, {} as never, {} as never,
  );
  const ctx = { from: { id: 7 }, chat: { id: 7, type: 'private' }, localeState: { locale: 'en', catalog: catalogFor('en'), user: { telegramId: 7, role: 'admin' } }, reply: vi.fn().mockResolvedValue({}) };
  return { ctx, handler, list };
}

describe('FeatureHandler', () => {
  it('renders exactly five full-width opaque feature list controls', async () => {
    const { handler, ctx } = setup();
    await handler.handleList(ctx as never, { receipt });
    const keyboard = ctx.reply.mock.calls[0][1].reply_markup.inline_keyboard;
    expect(keyboard.slice(0, 5)).toHaveLength(5);
    expect(keyboard.slice(0, 5).every((row: unknown[]) => row.length === 1)).toBe(true);
    expect(keyboard.slice(0, 5).map((row: Array<{ callback_data: string }>) => row[0].callback_data))
      .toEqual(['ft:d:abcdefghijklmnop:d', 'ft:d:abcdefghijklmnop:u', 'ft:d:abcdefghijklmnop:z', 'ft:d:abcdefghijklmnop:m', 'ft:d:abcdefghijklmnop:r']);
  });
});

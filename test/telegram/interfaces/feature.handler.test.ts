import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import { FeatureHandler } from '../../../src/telegram/interfaces/feature.handler';
import { FeatureAlreadyEnabledError } from '../../../src/features/domain/errors/feature-already-enabled.error';

const receipt = {
  id: 'abcdefghijklmnop', userId: 7, chatId: 7, kind: 'workflow-return' as const,
  sessionToken: null, status: 'pending' as const, expiresAt: new Date('2030-01-01'),
  payload: { workflow: 'feature' as const, phase: 'cancellable' as const, originSource: 'natural-parent' as const, origin: { kind: 'more' as const }, deliveryStage: 'pending' as const },
};

function setup() {
  const list = { execute: vi.fn().mockResolvedValue([
    { name: 'digital', installed: false, enabled: false, ready: false, busy: false, attentionReason: null, display: 'not-installed', action: 'install', secondaryAction: null },
    { name: 'uart', installed: true, enabled: false, ready: true, busy: false, attentionReason: null, display: 'installed-off', action: 'enable', secondaryAction: null },
    { name: 'zigbee', installed: true, enabled: true, ready: true, busy: false, attentionReason: null, display: 'enabled', action: 'disable', secondaryAction: null },
    { name: 'motion', installed: false, enabled: false, ready: false, busy: false, attentionReason: null, display: 'not-installed', action: 'install', secondaryAction: null },
    { name: 'rtsp', installed: false, enabled: false, ready: false, busy: false, attentionReason: null, display: 'not-installed', action: 'install', secondaryAction: null },
  ]) };
  const detail = { execute: vi.fn().mockResolvedValue({
    status: { name: 'digital', installed: false, enabled: false, ready: false, busy: false, attentionReason: null, display: 'not-installed', action: 'install', secondaryAction: null },
    impact: { dependencies: 'gpiod', controls: 'digital-sensors', monitoring: 'sensor-work', restartScope: 'worker' },
    secondary: null,
  }) };
  const install = { execute: vi.fn().mockResolvedValue({ job: {}, stage: 'running' }) };
  const enable = { execute: vi.fn().mockResolvedValue({}) };
  const disable = { execute: vi.fn().mockResolvedValue({}) };
  const verify = { execute: vi.fn().mockResolvedValue({ ready: true }) };
  const claim = { execute: vi.fn().mockResolvedValue({ kind: 'claimed', receipt, operation: { kind: 'feature-mutation', feature: 'digital', action: 'install', expectedInstalled: false, expectedEnabled: false, expectedAttentionReason: null } }) };
  const workflows = { begin: vi.fn().mockResolvedValue(receipt), loadCurrent: vi.fn().mockResolvedValue(receipt), completeHeadless: vi.fn() };
  const navigation = { complete: vi.fn().mockResolvedValue(undefined) };
  const outcomes = { register: vi.fn() };
  const handler = new FeatureHandler(
    list as never, detail as never, install as never, enable as never, disable as never, verify as never,
    claim as never, workflows as never,
    navigation as never, {} as never, outcomes as never, { findByTelegramId: vi.fn() } as never, {} as never,
    { adminOnly: vi.fn(), registered: vi.fn() } as never,
  );
  const ctx = { from: { id: 7 }, chat: { id: 7, type: 'private' }, localeState: { locale: 'en', catalog: catalogFor('en'), user: { telegramId: 7, role: 'admin' } }, reply: vi.fn().mockResolvedValue({}), answerCallbackQuery: vi.fn().mockResolvedValue(undefined) };
  return { ctx, handler, list, detail, install, enable, disable, verify, claim, workflows, navigation, outcomes };
}

describe('FeatureHandler', () => {
  it('renders exactly five full-width opaque feature list controls', async () => {
    const { handler, ctx } = setup();
    await handler.handleList(ctx as never, { receipt });
    const keyboard = ctx.reply.mock.calls[0][1].reply_markup.inline_keyboard;
    expect(keyboard.slice(0, 5)).toHaveLength(5);
    expect(keyboard.slice(0, 5).every((row: unknown[]) => row.length === 1)).toBe(true);
    expect(keyboard.slice(0, 5).map((row: { callback_data: string }[]) => row[0].callback_data))
      .toEqual(['ft:d:abcdefghijklmnop:d', 'ft:d:abcdefghijklmnop:u', 'ft:d:abcdefghijklmnop:z', 'ft:d:abcdefghijklmnop:m', 'ft:d:abcdefghijklmnop:r']);
  });

  it('registers recovery after locale and never treats direct commands as mutations', async () => {
    const { handler, outcomes, install, ctx } = setup();
    let command: ((ctx: typeof ctx) => Promise<void>) | undefined;
    const composer = { command: vi.fn((_: string, _guard: unknown, callback: typeof command) => { command = callback; }), callbackQuery: vi.fn() };
    handler.register(composer as never);
    await command!({ ...ctx, match: 'install digital' });
    expect(outcomes.register).toHaveBeenCalledWith(handler);
    expect(install.execute).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining(catalogFor('en').feature.description.digital),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );
    expect(catalogFor('en').feature.confirmation.install('Digital inputs', catalogFor('en').feature.restartScope.host))
      .toContain('Pi reboot');
    expect(catalogFor('en').feature.confirmation.install('Digital inputs', catalogFor('en').feature.restartScope.worker))
      .not.toContain('restart restart');
  });

  it('rejects extra command tokens with usage and no navigation receipt', async () => {
    const { handler, ctx, workflows } = setup();
    let command: ((ctx: typeof ctx) => Promise<void>) | undefined;
    handler.register({ command: vi.fn((_: string, _guard: unknown, callback: typeof command) => { command = callback; }), callbackQuery: vi.fn() } as never);
    await command!({ ...ctx, match: 'list extra' });
    expect(workflows.begin).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(catalogFor('en').feature.usage);
  });

  it('acknowledges malformed and stale callbacks without claiming a mutation', async () => {
    const { handler, ctx, claim } = setup();
    let callbackHandler: ((ctx: typeof ctx) => Promise<void>) | undefined;
    let matcher: RegExp | undefined;
    handler.register({ command: vi.fn(), callbackQuery: vi.fn((pattern: RegExp, _guard: unknown, callback: typeof callbackHandler) => { matcher = pattern; callbackHandler = callback; }) } as never);
    expect(matcher!.test('ft:c:bad')).toBe(true);
    await callbackHandler!({ ...ctx, callbackQuery: { data: 'ft:c:bad' } });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledOnce();
    expect(claim.execute).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(catalogFor('en').feature.recovery.stale);
  });

  it('passes the claimed exact expected snapshot to verification', async () => {
    const { handler, ctx, claim, verify } = setup();
    claim.execute.mockResolvedValueOnce({ kind: 'claimed', receipt, operation: { kind: 'feature-mutation', feature: 'digital', action: 'verify', expectedInstalled: true, expectedEnabled: true, expectedAttentionReason: 'readiness-failed' } });
    await (handler as any).confirm(ctx, receipt.id, true);
    expect(verify.execute).toHaveBeenCalledWith({ name: 'digital', source: 'manual', expected: { installed: true, enabled: true, attentionReason: 'readiness-failed' } });
  });

  it('rejects terminal delivery when its authoritative detail cannot be read so recovery can retry', async () => {
    const { handler, workflows } = setup();
    (handler as any).users = { findByTelegramId: vi.fn().mockResolvedValue({ telegramId: 7, locale: 'en', role: 'admin' }) };
    (handler as any).detail = { execute: vi.fn().mockRejectedValue(new Error('db unavailable')) };
    await expect(handler.notify({
      id: 'jobabcdefghijkl', feature: 'digital', status: 'succeeded', activeSlot: null,
      requestedByUserId: 7, requestedInChatId: 7, workflowReceiptId: receipt.id,
      previousInstalled: false, previousEnabled: false, restartScope: 'worker', failureCode: null,
      createdAt: new Date(), updatedAt: new Date(),
    })).rejects.toThrow('db unavailable');
    expect(workflows.completeHeadless).not.toHaveBeenCalled();
  });

  describe('reinstall on the current network', () => {
    it('offers the action only for an installed RTSP feature', async () => {
      const { handler, ctx, detail } = setup();
      detail.execute.mockResolvedValue(installedRtsp());

      await (handler as any).openDetail(ctx, receipt, 'rtsp');

      expect(labels(ctx)).toContain(catalogFor('en').feature.reinstallAction);
      expect(callbacks(ctx)).toContain('ft:r:abcdefghijklmnop:r');
    });

    it('offers nothing extra for a feature without an interface-bound policy', async () => {
      const { handler, ctx } = setup();

      await (handler as any).openDetail(ctx, receipt, 'digital');

      expect(labels(ctx)).not.toContain(catalogFor('en').feature.reinstallAction);
    });

    it('binds the confirmation to the exact rendered state and its full restart cost', async () => {
      const { handler, ctx, detail, workflows } = setup();
      detail.execute.mockResolvedValue(installedRtsp());

      await (handler as any).openDetail(ctx, receipt, 'rtsp', 'reinstall');

      expect(workflows.begin).toHaveBeenCalledWith(ctx, 'feature', expect.anything(), {
        kind: 'feature-mutation', feature: 'rtsp', action: 'reinstall',
        expectedInstalled: true, expectedEnabled: true, expectedAttentionReason: null,
      });
      const catalog = catalogFor('en').feature;
      expect(labels(ctx)).toContain(catalog.confirmation.reinstall('RTSP camera', catalog.restartScope.supervisor));
      // The offer is not repeated on the screen that already confirms it.
      expect(labels(ctx)).not.toContain(catalog.reinstallAction);
      expect(ctx.reply.mock.calls[0][0]).toContain(catalog.reinstallNotice);
    });

    it('reports an offer that vanished between the two screens instead of guessing', async () => {
      const { handler, ctx, workflows } = setup();

      await (handler as any).openDetail(ctx, receipt, 'digital', 'reinstall');

      expect(ctx.reply).toHaveBeenCalledWith(catalogFor('en').feature.errors.reinstallUnavailable('Digital inputs'));
      expect(workflows.begin).toHaveBeenCalledWith(ctx, 'feature', expect.anything(), expect.objectContaining({ action: 'install' }));
    });

    it('publishes the claimed reinstall with its captured prior state', async () => {
      const { handler, ctx, claim, install } = setup();
      claim.execute.mockResolvedValueOnce({
        kind: 'claimed', receipt,
        operation: { kind: 'feature-mutation', feature: 'rtsp', action: 'reinstall', expectedInstalled: true, expectedEnabled: true, expectedAttentionReason: null },
      });

      await (handler as any).confirm(ctx, receipt.id, false);

      expect(install.execute).toHaveBeenCalledWith({
        id: receipt.id, feature: 'rtsp', operation: 'reinstall',
        requestedByUserId: 7, requestedInChatId: 7, workflowReceiptId: receipt.id,
        expected: { installed: true, enabled: true },
      });
      expect(ctx.reply).toHaveBeenCalledWith(catalogFor('en').feature.progress.reinstalling('RTSP camera'));
    });

    it('keeps every feature control inside Telegram callback-data limits', async () => {
      const { handler, ctx, detail } = setup();
      detail.execute.mockResolvedValue(installedRtsp());

      await (handler as any).openDetail(ctx, receipt, 'rtsp');

      for (const data of callbacks(ctx)) {
        expect(Buffer.byteLength(data, 'utf8'), data).toBeLessThanOrEqual(64);
      }
      expect(receipt.id).toHaveLength(16);
    });

    it('acknowledges a reinstall control that names no feature without opening anything', async () => {
      const { handler, ctx, workflows } = setup();
      let callbackHandler: ((ctx: typeof ctx) => Promise<void>) | undefined;
      handler.register({ command: vi.fn(), callbackQuery: vi.fn((_: RegExp, _guard: unknown, cb: typeof callbackHandler) => { callbackHandler = cb; }) } as never);

      await callbackHandler!({ ...ctx, callbackQuery: { data: `ft:r:${receipt.id}` } });

      expect(workflows.loadCurrent).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(catalogFor('en').feature.recovery.stale);
    });
  });

  it('maps expected typed mutation errors to localized copy without treating them as unknown failures', async () => {
    const { handler, ctx, claim, enable, navigation } = setup();
    claim.execute.mockResolvedValueOnce({ kind: 'claimed', receipt, operation: { kind: 'feature-mutation', feature: 'digital', action: 'enable', expectedInstalled: true, expectedEnabled: false, expectedAttentionReason: null } });
    enable.execute.mockRejectedValueOnce(new FeatureAlreadyEnabledError('digital'));
    await (handler as any).confirm(ctx, receipt.id, false);
    expect(navigation.complete).toHaveBeenCalledWith(ctx, { receipt }, expect.objectContaining({ effectStage: 'pending' }));
    const presentation = navigation.complete.mock.calls[0][2];
    await presentation.deliver();
    expect(ctx.reply).toHaveBeenCalledWith(catalogFor('en').feature.errors.alreadyEnabled('Digital inputs'));
  });
});

function installedRtsp() {
  return {
    status: {
      name: 'rtsp', installed: true, enabled: true, ready: true, busy: false,
      attentionReason: null, display: 'enabled', action: 'disable', secondaryAction: 'reinstall',
    },
    impact: { dependencies: 'rtsp-runtime', controls: 'live-streams', monitoring: 'camera-work', restartScope: 'worker' },
    secondary: { action: 'reinstall', restartScope: 'supervisor' },
  };
}

function rows(ctx: { reply: { mock: { calls: unknown[][] } } }): { text: string; callback_data: string }[] {
  const last = ctx.reply.mock.calls.at(-1) as [string, { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }];
  return last[1].reply_markup.inline_keyboard.flat();
}

function labels(ctx: Parameters<typeof rows>[0]): string[] {
  return rows(ctx).map((button) => button.text);
}

function callbacks(ctx: Parameters<typeof rows>[0]): string[] {
  return rows(ctx).map((button) => button.callback_data);
}

import { describe, expect, it, vi } from 'vitest';
import { LiveSourceAddressOutsidePolicyError } from '../../../src/camera/domain/errors/live-source-address-outside-policy.error';
import { LiveSourceAuthenticationRejectedError } from '../../../src/camera/domain/errors/live-source-authentication-rejected.error';
import { LiveSourceHostNotFoundError } from '../../../src/camera/domain/errors/live-source-host-not-found.error';
import { LiveSourceHostUnreachableError } from '../../../src/camera/domain/errors/live-source-host-unreachable.error';
import { LiveSourceProbeFailedError } from '../../../src/camera/domain/errors/live-source-probe-failed.error';
import { LiveSourceProbeTimeoutError } from '../../../src/camera/domain/errors/live-source-probe-timeout.error';
import { LiveSourceTlsVerificationError } from '../../../src/camera/domain/errors/live-source-tls-verification.error';
import { LiveSourceUnsupportedStreamError } from '../../../src/camera/domain/errors/live-source-unsupported-stream.error';
import type { LiveSourceProbeError } from '../../../src/camera/domain/ports/live-source-probe.port';
import { catalogFor } from '../../../src/locales';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';
import { CameraSourcesHandler } from '../../../src/telegram/interfaces/camera-sources.handler';
import type { WorkflowEntryCoordinator } from '../../../src/telegram/interfaces/workflow-entry.coordinator';
import type { WorkflowNavigationHandler } from '../../../src/telegram/interfaces/workflow-navigation.handler';

const receipt = {
  id: 'abcdefghijklmnop',
  userId: 100,
  chatId: 42,
  kind: 'workflow-return',
  sessionToken: null,
  status: 'pending',
  expiresAt: new Date('2030-01-01'),
  payload: {
    workflow: 'camera',
    phase: 'cancellable',
    originSource: 'captured',
    origin: { kind: 'sensors', page: 1 },
  },
} satisfies WorkflowReturnReceipt;
const activeReceipt = {
  ...receipt,
  id: 'qrstuvwxyzabcdef',
} satisfies WorkflowReturnReceipt;
const source = {
  cameraId: 'camera-with-private-id',
  cameraName: 'Front door',
  summary: {
    scheme: 'rtsp' as const,
    host: 'camera.local:554',
    transport: 'tcp' as const,
    tlsMode: 'none' as const,
    profile: 'eco' as const,
    substreamHost: null,
    ready: true,
  },
  hasCredential: true,
  revision: 4,
  verifiedAt: null,
  policyDigest: null,
};

function setup() {
  const configure = { execute: vi.fn().mockResolvedValue(source) };
  const list = { execute: vi.fn().mockResolvedValue([source]) };
  const remove = { execute: vi.fn().mockResolvedValue({ removed: 'source' }) };
  const test = { execute: vi.fn().mockResolvedValue(source) };
  const workflows = {
    begin: vi.fn().mockResolvedValue(receipt),
    validateCurrent: vi.fn().mockResolvedValue(true),
    markRunning: vi.fn().mockResolvedValue(true),
  };
  const navigation = {
    complete: vi.fn(async (_ctx, _launch, presentation) => {
      await presentation.deliver();
    }),
  };
  const handler = new CameraSourcesHandler(
    configure as never,
    list as never,
    remove as never,
    test as never,
    { now: () => new Date('2026-07-17') },
    workflows as unknown as WorkflowEntryCoordinator,
    navigation as unknown as WorkflowNavigationHandler,
  );
  return { configure, handler, list, navigation, remove, test, workflows };
}

function context(input: { text?: string; role?: 'admin' | 'user'; messageId?: number } = {}) {
  return {
    from: { id: 100 },
    chat: { id: 42, type: 'private' },
    message: input.text === undefined ? undefined : { message_id: input.messageId ?? 71, text: input.text },
    localeState: {
      locale: 'en',
      catalog: catalogFor('en'),
      user: { telegramId: 100, role: input.role ?? 'admin' },
    },
    reply: vi.fn().mockResolvedValue({ message_id: 9 }),
    api: { deleteMessage: vi.fn().mockResolvedValue(true) },
  };
}

function keyboardData(ctx: ReturnType<typeof context>): string[] {
  return (ctx.reply.mock.calls as unknown[][]).flatMap((call) => callbackData(call[1]));
}

function callbackData(options: unknown): string[] {
  if (!isRecord(options) || !isRecord(options.reply_markup) || !Array.isArray(options.reply_markup.inline_keyboard))
    return [];
  return options.reply_markup.inline_keyboard.flatMap((row) =>
    Array.isArray(row)
      ? row.flatMap((button) =>
          isRecord(button) && typeof button.callback_data === 'string' ? [button.callback_data] : [],
        )
      : [],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

describe('CameraSourcesHandler contextual state', () => {
  it('renders only receipt-bound source callbacks without camera ids or credentials', async () => {
    const { handler } = setup();
    const ctx = context();
    await handler.handleEntry(ctx as never, { receipt });
    const data = keyboardData(ctx);

    expect(data).toEqual(expect.arrayContaining([
      'cam:abcdefghijklmnop:src:a',
      'cam:abcdefghijklmnop:src:e',
      'wr:abcdefghijklmnop:o',
      'wr:abcdefghijklmnop:h',
    ]));
    expect(data.every((value) => Buffer.byteLength(value, 'utf8') <= 64)).toBe(true);
    expect(JSON.stringify(data)).not.toContain('camera-with-private-id');
  });

  it('does not consume a stale credential prompt or delete its message', async () => {
    const { configure, handler, workflows } = setup();
    await handler.handleCallback(context() as never, 'a', receipt);
    workflows.validateCurrent.mockResolvedValueOnce(false);
    const credential = context({ text: 'rtsp://user:pass@camera.local/live' });

    await expect(handler.handleText(credential as never)).resolves.toBe(false);

    expect(configure.execute).not.toHaveBeenCalled();
    expect(credential.api.deleteMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(credential.reply.mock.calls)).not.toContain('user:pass');
  });

  it('uses the active source prompt after a newer Camera entry replaces stale state', async () => {
    const { handler, workflows } = setup();
    await handler.handleCallback(context() as never, 'a', receipt);
    await handler.handleCallback(context() as never, 'a', activeReceipt);
    workflows.validateCurrent.mockImplementation(async (_ctx, candidate) => candidate.id === activeReceipt.id);
    const camera = context({ text: 'Garden' });

    await expect(handler.handleText(camera as never)).resolves.toBe(true);

    expect(workflows.validateCurrent).toHaveBeenLastCalledWith(camera, activeReceipt);
    expect(camera.reply).toHaveBeenCalledWith(catalogFor('en').camera.sources.credentialPrompt, {
      reply_markup: expect.anything(),
    });
  });

  it('keys selection by receipt and resolves only opaque source selectors', async () => {
    const { handler } = setup();
    const ctx = context();
    await handler.handleCallback(ctx as never, 'e', receipt);
    const choices = keyboardData(ctx);

    expect(choices.some((value) => /^cam:abcdefghijklmnop:src:s:[A-Za-z0-9_-]{12}$/.test(value))).toBe(true);
    expect(JSON.stringify(choices)).not.toContain('camera-with-private-id');
  });

  it('removes under the revision the listing showed, on behalf of the receipt owner', async () => {
    const { handler, remove } = setup();
    const ctx = context();
    await handler.handleCallback(ctx as never, 'r', receipt);
    const selector = keyboardData(ctx).find((value) => value.includes(':src:s:'));

    await handler.handleCallback(ctx as never, selector!.split(':src:')[1], receipt);

    expect(remove.execute).toHaveBeenCalledWith({
      actorUserId: 100,
      cameraId: 'camera-with-private-id',
      expectedRevision: 4,
    });
  });

  it('tests a stored source without prompting for credentials or mutating it', async () => {
    const { configure, handler, test } = setup();
    const ctx = context();
    await handler.handleCallback(ctx as never, 't', receipt);
    const selector = keyboardData(ctx).find((value) => value.includes(':src:s:'));

    await handler.handleCallback(ctx as never, selector!.split(':src:')[1], receipt);

    expect(test.execute).toHaveBeenCalledWith({
      actorUserId: 100,
      cameraId: 'camera-with-private-id',
    });
    expect(configure.execute).not.toHaveBeenCalled();
    const replies = JSON.stringify(ctx.reply.mock.calls);
    expect(replies).toContain(catalogFor('en').camera.sources.verified('Front door'));
    expect(replies).not.toContain(catalogFor('en').camera.sources.credentialPrompt);
  });

  /**
   * Keyed by code so a missing member is a compile error, not a missing case:
   * the TLS key once read `LIVE_SOURCE_TLS_VERIFICATION` while the error throws
   * `..._FAILED`, and only that one code silently fell back to generic copy.
   */
  const probeErrors: Record<LiveSourceProbeError['code'], LiveSourceProbeError> = {
    LIVE_SOURCE_HOST_NOT_FOUND: new LiveSourceHostNotFoundError(),
    LIVE_SOURCE_HOST_UNREACHABLE: new LiveSourceHostUnreachableError(),
    LIVE_SOURCE_ADDRESS_OUTSIDE_POLICY: new LiveSourceAddressOutsidePolicyError(),
    LIVE_SOURCE_AUTHENTICATION_REJECTED: new LiveSourceAuthenticationRejectedError(),
    LIVE_SOURCE_TLS_VERIFICATION_FAILED: new LiveSourceTlsVerificationError(),
    LIVE_SOURCE_UNSUPPORTED_STREAM: new LiveSourceUnsupportedStreamError(),
    LIVE_SOURCE_PROBE_TIMEOUT: new LiveSourceProbeTimeoutError(),
    LIVE_SOURCE_PROBE_FAILED: new LiveSourceProbeFailedError(),
  };

  it.each(Object.values(probeErrors))(
    'renders $code as its own advice rather than the generic failure',
    async (probeError) => {
      const { handler, test } = setup();
      test.execute.mockRejectedValueOnce(probeError);
      const ctx = context();
      await handler.handleCallback(ctx as never, 't', receipt);
      const selector = keyboardData(ctx).find((value) => value.includes(':src:s:'));

      await handler.handleCallback(ctx as never, selector!.split(':src:')[1], receipt);

      const copy = catalogFor('en').camera.sources;
      const replies = JSON.stringify(ctx.reply.mock.calls);
      expect(replies).toContain(copy.probe[probeError.code]);
      expect(replies).not.toContain(copy.testFailed);
      // Nothing derived from the credentialed URL may reach the chat.
      expect(replies).not.toMatch(/rtsps?:\/\/|camera\.local/iu);
    },
  );

  it('gives every probe failure a distinct, non-empty message', () => {
    const copy = catalogFor('en').camera.sources;
    const advice = Object.values(probeErrors).map((probeError) => copy.probe[probeError.code]);

    expect(advice.every((line) => line.trim().length > 0)).toBe(true);
    expect(new Set(advice).size).toBe(advice.length);
    // The two copy requirements recorded when these kinds were classified.
    expect(copy.probe.LIVE_SOURCE_AUTHENTICATION_REJECTED).toMatch(/password/iu);
    expect(copy.probe.LIVE_SOURCE_AUTHENTICATION_REJECTED).toMatch(/path/iu);
    expect(copy.probe.LIVE_SOURCE_ADDRESS_OUTSIDE_POLICY).toMatch(/subnet/iu);
    expect(copy.probe.LIVE_SOURCE_ADDRESS_OUTSIDE_POLICY).toMatch(/IPv6/u);
  });

  // A code reaching the prototype chain must not hand a Function to ctx.reply.
  it('falls back to the generic message for a code that is not its own key', async () => {
    const { handler, test } = setup();
    const impostor = new LiveSourceProbeFailedError();
    Object.defineProperty(impostor, 'code', { value: 'toString' });
    test.execute.mockRejectedValueOnce(impostor);
    const ctx = context();
    await handler.handleCallback(ctx as never, 't', receipt);
    const selector = keyboardData(ctx).find((value) => value.includes(':src:s:'));

    await handler.handleCallback(ctx as never, selector!.split(':src:')[1], receipt);

    const replies = ctx.reply.mock.calls.flat();
    expect(replies).toContain(catalogFor('en').camera.sources.testFailed);
    expect(replies.every((reply) => typeof reply !== 'function')).toBe(true);
  });

  it('marks configuration running before using and deleting the credential text', async () => {
    const { configure, handler, workflows } = setup();
    await handler.handleCallback(context() as never, 'a', receipt);
    await handler.handleText(context({ text: 'Front door' }) as never);
    const credential = context({
      text: 'rtsps://user:pass@camera.local/live',
      messageId: 88,
    });

    await handler.handleText(credential as never);

    expect(workflows.markRunning).toHaveBeenCalledWith(credential, receipt);
    expect(configure.execute).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 100, cameraName: 'Front door', tlsMode: 'strict' }),
    );
    expect(credential.api.deleteMessage).toHaveBeenCalledWith(42, 88);
    expect(JSON.stringify(credential.reply.mock.calls)).not.toContain('user:pass');
  });
});

import { Composer } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { catalogFor } from '../../../src/locales';
import type { BeginWorkflowReturnUseCase } from '../../../src/telegram/application/begin-workflow-return.use-case';
import type { ClaimWorkflowReturnUseCase } from '../../../src/telegram/application/claim-workflow-return.use-case';
import type { CompleteWorkflowReturnUseCase } from '../../../src/telegram/application/complete-workflow-return.use-case';
import type { RestoreWorkflowOriginUseCase } from '../../../src/telegram/application/restore-workflow-origin.use-case';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';
import { WorkflowDraftRegistry } from '../../../src/telegram/interfaces/workflow-draft.registry';
import { WorkflowEntryCoordinator, type WorkflowLaunch } from '../../../src/telegram/interfaces/workflow-entry.coordinator';
import { WorkflowNavigationHandler } from '../../../src/telegram/interfaces/workflow-navigation.handler';
import { WorkflowNavigationPresenter } from '../../../src/telegram/interfaces/workflow-navigation.presenter';
import { WorkflowOperationQueue } from '../../../src/telegram/interfaces/workflow-operation.queue';
import type { RoleMiddleware } from '../../../src/telegram/interfaces/role.middleware';
import type { TelegramContext } from '../../../src/telegram/interfaces/telegram-context';

const receipt = {
  id: 'abcdefghijklmnop', userId: 7, chatId: 70, kind: 'workflow-return',
  sessionToken: 'home-session-token', status: 'pending', expiresAt: new Date('2030-01-02T00:00:00.000Z'),
  payload: { workflow: 'camera', phase: 'cancellable', originSource: 'captured', origin: { kind: 'history' } },
} satisfies WorkflowReturnReceipt;

function context(data = `wr:${receipt.id}:o`, overrides: Partial<TelegramContext> = {}): TelegramContext {
  return {
    from: { id: 7 }, chat: { id: 70, type: 'private' }, callbackQuery: { data },
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    reply: vi.fn().mockResolvedValue({ message_id: 99 }),
    localeState: {
      locale: 'en', catalog: catalogFor('en'),
      user: { telegramId: 7, name: 'User', role: 'user', locale: 'en', muted: false, nonCriticalPausedUntil: null, notificationPauseRevision: 0, quietStart: null, quietEnd: null, createdAt: null },
    },
    ...overrides,
  } as unknown as TelegramContext;
}

type ClaimResult = Awaited<ReturnType<ClaimWorkflowReturnUseCase['execute']>>;

function setup(
  claimResult: ClaimResult = { kind: 'claimed', receipt: { ...receipt, status: 'executing' } },
  queue = new WorkflowOperationQueue(),
) {
  const claim = { execute: vi.fn().mockResolvedValue(claimResult) };
  const complete = { execute: vi.fn().mockResolvedValue('finished') };
  const restore = { execute: vi.fn().mockResolvedValue({ kind: 'opened', active: { userId: 7, chatId: 70, messageId: 1, token: 'new-home-token', revision: 1 }, view: { kind: 'history' } }) };
  const registry = new WorkflowDraftRegistry();
  const cancelExact = vi.spyOn(registry, 'cancelExact').mockResolvedValue('cancelled');
  const guard = { registered: vi.fn() };
  const handler = new WorkflowNavigationHandler(
    guard as unknown as RoleMiddleware,
    claim as unknown as ClaimWorkflowReturnUseCase,
    complete as unknown as CompleteWorkflowReturnUseCase,
    restore as unknown as RestoreWorkflowOriginUseCase,
    registry,
    queue,
    new WorkflowNavigationPresenter(),
  );
  let regex!: RegExp;
  let callback!: (ctx: TelegramContext) => Promise<void>;
  const composer = {
    callbackQuery: vi.fn((filter: RegExp, _guard: unknown, fn: typeof callback) => { regex = filter; callback = fn; }),
  } as unknown as Composer<TelegramContext>;
  handler.register(composer);
  return { callback, cancelExact, claim, complete, composer, guard, handler, regex, restore };
}

describe('WorkflowNavigationHandler', () => {
  it('registers the exact wr callback behind the registered-user guard', () => {
    const { composer, guard, regex } = setup();
    expect(composer.callbackQuery).toHaveBeenCalledWith(expect.any(RegExp), guard.registered, expect.any(Function));
    expect(regex.source).toBe('^wr:[A-Za-z0-9_-]{16}:[oh]$');
    expect(regex.test('wr:abcdefghijklmnop:o')).toBe(true);
    expect(regex.test('wr:abcdefghijklmnop:o\n')).toBe(false);
    expect(regex.test('wr:abcdefghijklmnop:x')).toBe(false);
  });

  it('acknowledges once before serialized processing', async () => {
    const { callback } = setup();
    const ctx = context(undefined, { homeCallbackAcknowledged: true });
    await callback(ctx);
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled();

    const fresh = context();
    await callback(fresh);
    expect(fresh.answerCallbackQuery).toHaveBeenCalledOnce();
    expect(fresh.homeCallbackAcknowledged).toBe(true);
  });

  it.each([
    ['unregistered', { localeState: undefined }],
    ['non-private', { chat: { id: -70, type: 'group' } }],
    ['mismatched current identity', { from: { id: 8 } }],
  ])('does not claim for %s updates', async (_label, overrides) => {
    const { callback, claim } = setup();
    await callback(context(undefined, overrides as Partial<TelegramContext>));
    expect(claim.execute).not.toHaveBeenCalled();
  });

  it('allows a demoted admin through the registered-user route and reauthorizes the origin', async () => {
    const { callback, restore } = setup();
    await callback(context());
    expect(restore.execute).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', requested: { kind: 'history' } }));
  });

  it('claims, cleans the exact cancellable draft, restores its origin, then marks returned', async () => {
    const { callback, cancelExact, complete, restore } = setup();
    const order: string[] = [];
    cancelExact.mockImplementation(async () => { order.push('cleanup'); return 'cancelled'; });
    restore.execute.mockImplementation(async () => { order.push('restore'); return { kind: 'opened' }; });
    complete.execute.mockImplementation(async () => { order.push('finish'); return 'finished'; });

    await callback(context());
    expect(cancelExact).toHaveBeenCalledWith(expect.objectContaining({ id: receipt.id }));
    expect(restore.execute).toHaveBeenCalledWith(expect.objectContaining({
      workflow: 'camera', requested: { kind: 'history' }, originSource: 'captured',
    }));
    expect(complete.execute).toHaveBeenCalledWith({ userId: 7, chatId: 70, id: receipt.id, outcome: 'returned' });
    expect(order).toEqual(['cleanup', 'restore', 'finish']);
  });

  it('opens Home for the h destination instead of the stored origin', async () => {
    const { callback, restore } = setup();
    await callback(context(`wr:${receipt.id}:h`));
    expect(restore.execute).toHaveBeenCalledWith(expect.objectContaining({
      requested: { kind: 'home', checking: false }, originSource: 'captured',
    }));
  });

  it('never cancels running work before restoring', async () => {
    const running = { ...receipt, status: 'executing' as const, payload: { ...receipt.payload, phase: 'running' as const } };
    const { callback, cancelExact, restore } = setup({ kind: 'claimed', receipt: running });
    await callback(context());
    expect(cancelExact).not.toHaveBeenCalled();
    expect(restore.execute).toHaveBeenCalledOnce();
  });

  it('retries restoration for executing receipts without repeating cleanup', async () => {
    const executing = { ...receipt, status: 'executing' as const };
    const { callback, cancelExact, restore } = setup({ kind: 'resumable', receipt: executing });
    await callback(context());
    expect(cancelExact).not.toHaveBeenCalled();
    expect(restore.execute).toHaveBeenCalledOnce();
  });

  it.each(['expired', 'superseded', 'terminal'] as const)('treats %s callbacks as harmless', async (kind) => {
    const { callback, cancelExact, complete, restore } = setup({ kind });
    await callback(context());
    expect(cancelExact).not.toHaveBeenCalled();
    expect(restore.execute).not.toHaveBeenCalled();
    expect(complete.execute).not.toHaveBeenCalled();
  });

  it('reports restart-lost cancellable state as a transient notice on restored Home', async () => {
    const { callback, cancelExact, restore } = setup();
    cancelExact.mockResolvedValue('missing');
    const ctx = context();
    await callback(ctx);
    expect(restore.execute).toHaveBeenCalledWith(expect.objectContaining({ notice: ctx.localeState?.catalog.common.interrupted }));
  });

  it('keeps executing resumable and edits Retry return markup when restoration fails', async () => {
    const { callback, complete, restore } = setup();
    restore.execute.mockResolvedValue({ kind: 'resumable' });
    const ctx = context();
    await callback(ctx);
    expect(complete.execute).not.toHaveBeenCalled();
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({
      reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }),
    });
    expect(JSON.stringify((ctx.editMessageReplyMarkup as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain(`wr:${receipt.id}:o`);
  });

  it('sends localized recovery copy when retry-markup editing also fails', async () => {
    const { callback, restore } = setup();
    restore.execute.mockRejectedValue(new Error('delivery failed'));
    const ctx = context(undefined, { editMessageReplyMarkup: vi.fn().mockRejectedValue(new Error('edit failed')) });
    await callback(ctx);
    expect(ctx.reply).toHaveBeenCalledWith(ctx.localeState?.catalog.home.recovery.unavailable, {
      reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }),
    });
  });

  it('turns a terminal result-send failure into a transient Home notice', async () => {
    const { handler, restore, complete } = setup();
    const ctx = context();
    const failureNotice = 'Localized outcome notice';
    await handler.complete(ctx, { receipt } satisfies WorkflowLaunch, {
      deliver: vi.fn().mockRejectedValue(new Error('send failed')),
      failureNotice,
    });
    expect(restore.execute).toHaveBeenCalledWith(expect.objectContaining({ notice: failureNotice }));
    expect(complete.execute).toHaveBeenCalledWith({ userId: 7, chatId: 70, id: receipt.id, outcome: 'completed' });
  });

  it('lets a returned running job send its result without moving Home', async () => {
    const returned = { ...receipt, status: 'returned' as const, payload: { ...receipt.payload, phase: 'running' as const } };
    const { handler, restore, complete } = setup({ kind: 'returned', receipt: returned });
    const deliver = vi.fn().mockResolvedValue(undefined);
    await handler.complete(context(), { receipt: returned }, { deliver, failureNotice: 'notice' });
    expect(deliver).toHaveBeenCalledOnce();
    expect(restore.execute).not.toHaveBeenCalled();
    expect(complete.execute).toHaveBeenCalledWith({ userId: 7, chatId: 70, id: receipt.id, outcome: 'completed' });
  });

  it('lets a superseded running job send its result without moving the newer Home', async () => {
    const running = { ...receipt, status: 'executing' as const, payload: { ...receipt.payload, phase: 'running' as const } };
    const { handler, restore, complete } = setup({ kind: 'superseded' });
    const deliver = vi.fn().mockResolvedValue(undefined);

    await handler.complete(context(), { receipt: running }, { deliver, failureNotice: 'notice' });

    expect(deliver).toHaveBeenCalledOnce();
    expect(restore.execute).not.toHaveBeenCalled();
    expect(complete.execute).not.toHaveBeenCalled();
  });

  it('serializes return, background completion, and a new begin so only the current claim restores Home', async () => {
    let releaseRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => { releaseRestore = resolve; });
    const queue = new WorkflowOperationQueue();
    const running = { ...receipt, status: 'executing' as const, payload: { ...receipt.payload, phase: 'running' as const } };
    const setupResult = setup({ kind: 'claimed', receipt: running }, queue);
    setupResult.claim.execute
      .mockResolvedValueOnce({ kind: 'claimed', receipt: running })
      .mockResolvedValueOnce({ kind: 'returned', receipt: { ...running, status: 'returned' } });
    setupResult.restore.execute.mockImplementation(async () => {
      await restoreGate;
      return { kind: 'opened' };
    });
    const nextReceipt = { ...receipt, id: 'qrstuvwxyzabcdef', payload: { ...receipt.payload, workflow: 'help' as const } };
    const begin = { execute: vi.fn().mockResolvedValue({ receipt: nextReceipt, replaced: { ...running, status: 'returned' } }) };
    const coordinator = new WorkflowEntryCoordinator(
      begin as unknown as BeginWorkflowReturnUseCase,
      new WorkflowDraftRegistry(),
      queue,
    );
    const deliver = vi.fn().mockResolvedValue(undefined);

    const returning = setupResult.callback(context());
    await vi.waitFor(() => expect(setupResult.restore.execute).toHaveBeenCalledOnce());
    const completing = setupResult.handler.complete(context(), { receipt: running }, { deliver, failureNotice: 'notice' });
    const beginning = coordinator.begin(context(), 'help', { source: 'natural-parent' });
    expect(deliver).not.toHaveBeenCalled();
    expect(begin.execute).not.toHaveBeenCalled();

    releaseRestore();
    await Promise.all([returning, completing, beginning]);
    expect(setupResult.restore.execute).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledOnce();
    expect(begin.execute).toHaveBeenCalledOnce();
  });
});

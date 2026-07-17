import { describe, expect, it, vi } from 'vitest';
import type { BeginWorkflowReturnUseCase } from '../../../src/telegram/application/begin-workflow-return.use-case';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';
import { catalogFor } from '../../../src/locales';
import { WorkflowDraftRegistry } from '../../../src/telegram/interfaces/workflow-draft.registry';
import { WorkflowEntryCoordinator } from '../../../src/telegram/interfaces/workflow-entry.coordinator';
import { WorkflowOperationQueue } from '../../../src/telegram/interfaces/workflow-operation.queue';
import type { TelegramContext } from '../../../src/telegram/interfaces/telegram-context';

const receipt = {
  id: 'abcdefghijklmnop', userId: 7, chatId: 70, kind: 'workflow-return',
  sessionToken: null, status: 'pending', expiresAt: new Date('2030-01-02T00:00:00.000Z'),
  payload: { workflow: 'camera', phase: 'cancellable', originSource: 'natural-parent', origin: { kind: 'home', checking: false } },
} satisfies WorkflowReturnReceipt;

function context(overrides: Partial<TelegramContext> = {}): TelegramContext {
  return {
    from: { id: 7 },
    chat: { id: 70, type: 'private' },
    localeState: {
      locale: 'en', catalog: catalogFor('en'),
      user: { telegramId: 7, name: 'User', role: 'user', locale: 'en', muted: false, nonCriticalPausedUntil: null, notificationPauseRevision: 0, quietStart: null, quietEnd: null, createdAt: null },
    },
    ...overrides,
  } as unknown as TelegramContext;
}

function setup(result: { receipt: WorkflowReturnReceipt; replaced: WorkflowReturnReceipt | null } = { receipt, replaced: null }) {
  const execute = vi.fn().mockResolvedValue(result);
  const registry = new WorkflowDraftRegistry();
  const cancelExact = vi.spyOn(registry, 'cancelExact');
  const coordinator = new WorkflowEntryCoordinator(
    { execute } as unknown as BeginWorkflowReturnUseCase,
    registry,
    new WorkflowOperationQueue(),
    {} as never,
    { now: () => new Date('2030-01-01T00:00:00.000Z') },
  );
  return { coordinator, execute, registry, cancelExact };
}

function leaveSetup({
  current = receipt,
  claim = { kind: 'claimed' as const, receipt },
}: {
  current?: WorkflowReturnReceipt | null;
  claim?: { kind: 'claimed' | 'resumable' | 'returned'; receipt: WorkflowReturnReceipt } | { kind: 'expired' | 'superseded' | 'terminal' };
} = {}) {
  const actions = {
    findWorkflowReturn: vi.fn().mockResolvedValue(current),
    claimWorkflowReturn: vi.fn().mockResolvedValue(claim),
    finishWorkflowReturn: vi.fn().mockResolvedValue('finished'),
  };
  const registry = new WorkflowDraftRegistry();
  const cancelExact = vi.spyOn(registry, 'cancelExact').mockResolvedValue('cancelled');
  const coordinator = new WorkflowEntryCoordinator(
    { execute: vi.fn() } as unknown as BeginWorkflowReturnUseCase,
    registry,
    new WorkflowOperationQueue(),
    actions as never,
    { now: () => new Date('2030-01-01T00:00:00.000Z') },
  );
  return { coordinator, actions, cancelExact };
}

describe('WorkflowEntryCoordinator', () => {
  it.each([
    ['unregistered', { localeState: undefined }],
    ['non-private', { chat: { id: -70, type: 'group' } }],
    ['mismatched current user', { from: { id: 8 } }],
  ])('ignores %s entry without creating a receipt', async (_label, override) => {
    const { coordinator, execute } = setup();

    await expect(coordinator.begin(context(override as Partial<TelegramContext>), 'camera', { source: 'natural-parent' })).resolves.toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('captures the exact validated Home origin and token once', async () => {
    const { coordinator, execute } = setup();

    await expect(coordinator.begin(context(), 'logs', {
      source: 'captured', view: { kind: 'history' }, sessionToken: 'home-session-token',
    })).resolves.toBe(receipt);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({
      userId: 7, chatId: 70, workflow: 'logs', origin: { kind: 'history' },
      originSource: 'captured', sessionToken: 'home-session-token',
    });
  });

  it('materializes the centralized natural parent for direct commands', async () => {
    const { coordinator, execute } = setup();

    await coordinator.begin(context(), 'csv', { source: 'natural-parent' });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      origin: { kind: 'history' }, originSource: 'natural-parent', sessionToken: null,
    }));
  });

  it('cleans an atomically replaced cancellable draft only after replacement', async () => {
    const replaced = { ...receipt, id: 'qrstuvwxyzabcdef' } satisfies WorkflowReturnReceipt;
    const { coordinator, registry, execute } = setup({ receipt, replaced });
    const events: string[] = [];
    execute.mockImplementation(async () => { events.push('replace'); return { receipt, replaced }; });
    vi.spyOn(registry, 'cancelExact').mockImplementation(async () => { events.push('cleanup'); return 'cancelled'; });

    await coordinator.begin(context(), 'camera', { source: 'natural-parent' });
    expect(events).toEqual(['replace', 'cleanup']);
  });

  it('never calls draft cancellation when replacing running work', async () => {
    const replaced = { ...receipt, id: 'qrstuvwxyzabcdef', payload: { ...receipt.payload, phase: 'running' as const } } satisfies WorkflowReturnReceipt;
    const { coordinator, cancelExact } = setup({ receipt, replaced });

    await coordinator.begin(context(), 'camera', { source: 'natural-parent' });
    expect(cancelExact).not.toHaveBeenCalled();
  });

  it.each([
    ['cancellable', receipt, true],
    ['running', { ...receipt, payload: { ...receipt.payload, phase: 'running' as const } }, false],
  ] as const)('leaves a claimed %s workflow before promoting the requested fresh Home destination', async (_phase, current, cancelsDraft) => {
    const { coordinator, actions, cancelExact } = leaveSetup({
      current,
      claim: { kind: 'claimed', receipt: current },
    });
    const promote = vi.fn().mockResolvedValue(true);

    await expect(coordinator.leaveForHome(context(), promote)).resolves.toBe('opened');

    expect(actions.claimWorkflowReturn).toHaveBeenCalledWith({ userId: 7, chatId: 70, id: current.id, now: new Date('2030-01-01T00:00:00.000Z') });
    expect(cancelExact).toHaveBeenCalledTimes(cancelsDraft ? 1 : 0);
    expect(promote).toHaveBeenCalledOnce();
    expect(actions.finishWorkflowReturn).toHaveBeenCalledWith({
      userId: 7,
      chatId: 70,
      id: current.id,
      outcome: 'returned',
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
  });

  it('does not clean, promote, or finish when the current receipt becomes stale before claim', async () => {
    const { coordinator, actions, cancelExact } = leaveSetup({ claim: { kind: 'superseded' } });
    const promote = vi.fn().mockResolvedValue(true);

    await expect(coordinator.leaveForHome(context(), promote)).resolves.toBe('stale');

    expect(cancelExact).not.toHaveBeenCalled();
    expect(promote).not.toHaveBeenCalled();
    expect(actions.finishWorkflowReturn).not.toHaveBeenCalled();
  });

  it('treats a previously returned running workflow as inactive without repeating cleanup or promotion', async () => {
    const returned = {
      ...receipt,
      status: 'returned' as const,
      payload: { ...receipt.payload, phase: 'running' as const },
    } satisfies WorkflowReturnReceipt;
    const { coordinator, actions, cancelExact } = leaveSetup({
      current: returned,
      claim: { kind: 'returned', receipt: returned },
    });
    const promote = vi.fn().mockResolvedValue(true);

    await expect(coordinator.leaveForHome(context(), promote)).resolves.toBe('no-workflow');

    expect(cancelExact).not.toHaveBeenCalled();
    expect(promote).not.toHaveBeenCalled();
    expect(actions.finishWorkflowReturn).not.toHaveBeenCalled();
  });

  it('keeps a claimed receipt resumable when fresh Home promotion fails', async () => {
    const { coordinator, actions } = leaveSetup();
    const promote = vi.fn().mockResolvedValue(false);

    await expect(coordinator.leaveForHome(context(), promote)).resolves.toBe('not-opened');

    expect(actions.finishWorkflowReturn).not.toHaveBeenCalled();
  });

  it('delivers a recovered restart result once and retries only its origin restoration', async () => {
    const restartReceipt = {
      ...receipt,
      payload: { ...receipt.payload, workflow: 'system-restart' as const, phase: 'running' as const },
    } satisfies WorkflowReturnReceipt;
    const actions = {
      findWorkflowReturn: vi.fn().mockResolvedValue(restartReceipt),
      claimWorkflowReturn: vi.fn()
        .mockResolvedValueOnce({ kind: 'claimed', receipt: { ...restartReceipt, status: 'executing' as const } })
        .mockResolvedValueOnce({ kind: 'resumable', receipt: { ...restartReceipt, status: 'executing' as const } }),
      finishWorkflowReturn: vi.fn().mockResolvedValue('finished'),
    };
    const coordinator = new WorkflowEntryCoordinator(
      { execute: vi.fn() } as unknown as BeginWorkflowReturnUseCase,
      new WorkflowDraftRegistry(),
      new WorkflowOperationQueue(),
      actions as never,
      { now: () => new Date('2030-01-01T00:00:00.000Z') },
    );
    const deliver = vi.fn().mockResolvedValue(undefined);
    const restore = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const identity = {
      userId: 7,
      chatId: 70,
      locale: 'en' as const,
      role: 'admin' as const,
      catalog: catalogFor('en'),
    };

    await expect((coordinator as unknown as {
      completeHeadless(input: {
        identity: typeof identity;
        workflow: 'system-restart';
        deliver(): Promise<void>;
        restore(receipt: WorkflowReturnReceipt): Promise<boolean>;
      }): Promise<string>;
    }).completeHeadless({ identity, workflow: 'system-restart', deliver, restore })).resolves.toBe('resumable');

    await expect((coordinator as unknown as {
      completeHeadless(input: {
        identity: typeof identity;
        workflow: 'system-restart';
        deliver(): Promise<void>;
        restore(receipt: WorkflowReturnReceipt): Promise<boolean>;
      }): Promise<string>;
    }).completeHeadless({ identity, workflow: 'system-restart', deliver, restore })).resolves.toBe('completed');

    expect(deliver).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledTimes(2);
    expect(actions.finishWorkflowReturn).toHaveBeenCalledWith(expect.objectContaining({
      id: restartReceipt.id,
      outcome: 'completed',
    }));
  });

  it('keeps a recovered restart resumable when terminal result delivery fails', async () => {
    const restartReceipt = {
      ...receipt,
      payload: { ...receipt.payload, workflow: 'system-restart' as const, phase: 'running' as const },
    } satisfies WorkflowReturnReceipt;
    const actions = {
      findWorkflowReturn: vi.fn().mockResolvedValue(restartReceipt),
      claimWorkflowReturn: vi.fn().mockResolvedValue({
        kind: 'claimed',
        receipt: { ...restartReceipt, status: 'executing' as const },
      }),
      finishWorkflowReturn: vi.fn().mockResolvedValue('finished'),
    };
    const coordinator = new WorkflowEntryCoordinator(
      { execute: vi.fn() } as unknown as BeginWorkflowReturnUseCase,
      new WorkflowDraftRegistry(),
      new WorkflowOperationQueue(),
      actions as never,
      { now: () => new Date('2030-01-01T00:00:00.000Z') },
    );
    const identity = {
      userId: 7,
      chatId: 70,
      locale: 'en' as const,
      role: 'admin' as const,
      catalog: catalogFor('en'),
    };
    const deliver = vi.fn().mockRejectedValue(new Error('Telegram unavailable'));
    const restore = vi.fn().mockResolvedValue(true);

    await expect(coordinator.completeHeadless({
      identity,
      workflow: 'system-restart',
      deliver,
      restore,
    })).resolves.toBe('resumable');

    expect(deliver).toHaveBeenCalledOnce();
    expect(restore).not.toHaveBeenCalled();
    expect(actions.finishWorkflowReturn).not.toHaveBeenCalled();
  });
});

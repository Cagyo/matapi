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
  );
  return { coordinator, execute, registry, cancelExact };
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
});

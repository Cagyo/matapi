import { describe, expect, it, vi } from 'vitest';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';
import {
  WorkflowDraftRegistry,
  type WorkflowDraftCanceller,
} from '../../../src/telegram/interfaces/workflow-draft.registry';

const receipt = {
  id: 'abcdefghijklmnop',
  userId: 7,
  chatId: 70,
  kind: 'workflow-return',
  sessionToken: null,
  status: 'pending',
  expiresAt: new Date('2030-01-02T00:00:00.000Z'),
  payload: {
    workflow: 'camera',
    phase: 'cancellable',
    originSource: 'natural-parent',
    origin: { kind: 'home', checking: false },
  },
} satisfies WorkflowReturnReceipt;

describe('WorkflowDraftRegistry', () => {
  it('routes cleanup to the registered workflow with the exact receipt identity', async () => {
    const cancelExact = vi.fn().mockResolvedValue('cancelled');
    const registry = new WorkflowDraftRegistry();
    registry.register('camera', { cancelExact } satisfies WorkflowDraftCanceller);

    await expect(registry.cancelExact(receipt)).resolves.toBe('cancelled');
    expect(cancelExact).toHaveBeenCalledWith({
      userId: 7,
      chatId: 70,
      receiptId: 'abcdefghijklmnop',
    });
  });

  it('treats a missing in-memory owner after restart as a harmless no-op', async () => {
    const registry = new WorkflowDraftRegistry();

    await expect(registry.cancelExact(receipt)).resolves.toBe('missing');
  });

  it('uses the latest registration without retaining a handler dependency graph', async () => {
    const first = { cancelExact: vi.fn().mockResolvedValue('cancelled') };
    const latest = { cancelExact: vi.fn().mockResolvedValue('superseded') };
    const registry = new WorkflowDraftRegistry();
    registry.register('camera', first);
    registry.register('camera', latest);

    await expect(registry.cancelExact(receipt)).resolves.toBe('superseded');
    expect(first.cancelExact).not.toHaveBeenCalled();
    expect(latest.cancelExact).toHaveBeenCalledOnce();
  });
});

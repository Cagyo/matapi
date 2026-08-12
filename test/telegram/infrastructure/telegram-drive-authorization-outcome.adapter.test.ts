import { describe, expect, it, vi } from 'vitest';
import { en } from '../../../src/locales/en';
import { TelegramDriveAuthorizationOutcomeAdapter } from '../../../src/telegram/infrastructure/telegram-drive-authorization-outcome.adapter';
import type { WorkflowEntryCoordinator } from '../../../src/telegram/interfaces/workflow-entry.coordinator';

const authorized = {
  kind: 'authorized',
  generationId: 'generation-00001',
  receiptId: 'abcdefghijklmnop',
  adminUserId: 7,
  chatId: 9,
  account: { permissionId: 'permission-1', email: 'owner@example.test', displayName: 'Owner' },
} as const;

const failed = {
  kind: 'failed',
  generationId: 'generation-00001',
  receiptId: 'abcdefghijklmnop',
  adminUserId: 7,
  chatId: 9,
  reason: 'policy',
} as const;

function setup() {
  const users = {
    findByTelegramId: vi.fn().mockResolvedValue({ telegramId: 7, role: 'admin', locale: 'en' }),
  };
  const messenger = { send: vi.fn().mockResolvedValue(undefined) };
  const states = {
    observeAuthorized: vi.fn().mockReturnValue({ kind: 'authorizing' }),
    takeTerminal: vi.fn().mockReturnValue({ kind: 'authorizing' }),
  };
  const receipt = {
    id: 'abcdefghijklmnop', userId: 7, chatId: 9, kind: 'workflow-return',
    sessionToken: null, status: 'executing', expiresAt: new Date('2030-01-02T00:00:00.000Z'),
    payload: {
      workflow: 'drive-setup', phase: 'running', originSource: 'natural-parent',
      origin: { kind: 'admin-storage' },
    },
  } as const;
  const workflows = {
    completeHeadless: vi.fn(async (input: Parameters<WorkflowEntryCoordinator['completeHeadless']>[0]) => {
      await input.deliver();
      await input.restore(receipt, input.recoveryNotice);
      return 'completed' as const;
    }),
  };
  const restore = { execute: vi.fn().mockResolvedValue({ kind: 'opened' }) };
  const adapter = new TelegramDriveAuthorizationOutcomeAdapter(
    users as never, messenger, states as never, workflows as never, restore as never,
  );
  return { adapter, messenger, states, workflows, restore };
}

describe('TelegramDriveAuthorizationOutcomeAdapter', () => {
  it('retains the exact authorizing state after an authorized outcome', async () => {
    const fixture = setup();

    await fixture.adapter.publish(authorized);

    expect(fixture.states.observeAuthorized).toHaveBeenCalledWith({
      userId: 7, chatId: 9, receiptId: 'abcdefghijklmnop', generationId: 'generation-00001',
    });
    expect(fixture.states.takeTerminal).not.toHaveBeenCalled();
    expect(fixture.workflows.completeHeadless).not.toHaveBeenCalled();
    expect(fixture.messenger.send).toHaveBeenCalledWith(7, en.gdriveConnection.authorizationReady('Owner'));
  });

  it('takes the exact terminal state and restores the receipt origin for failure', async () => {
    const fixture = setup();

    await fixture.adapter.publish(failed);

    expect(fixture.states.takeTerminal).toHaveBeenCalledWith({
      userId: 7, chatId: 9, receiptId: 'abcdefghijklmnop', generationId: 'generation-00001',
    });
    expect(fixture.workflows.completeHeadless).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({ userId: 7, chatId: 9, locale: 'en', role: 'admin' }),
      workflow: 'drive-setup', receiptId: 'abcdefghijklmnop',
      recoveryNotice: en.gdriveConnection.policyBlocked,
    }));
    expect(fixture.messenger.send).toHaveBeenCalledWith(7, en.gdriveConnection.policyBlocked);
    expect(fixture.restore.execute).toHaveBeenCalledWith({
      userId: 7, chatId: 9, locale: 'en', role: 'admin', workflow: 'drive-setup',
      requested: { kind: 'admin-storage' }, originSource: 'natural-parent',
      notice: en.gdriveConnection.policyBlocked,
    });
  });

  it('does nothing for a stale terminal outcome', async () => {
    const fixture = setup();
    fixture.states.takeTerminal.mockReturnValueOnce(null);

    await fixture.adapter.publish({
      ...failed, generationId: 'stale-generation', receiptId: 'stale-receipt', reason: 'unavailable',
    });

    expect(fixture.workflows.completeHeadless).not.toHaveBeenCalled();
    expect(fixture.messenger.send).not.toHaveBeenCalled();
    expect(fixture.restore.execute).not.toHaveBeenCalled();
  });
});

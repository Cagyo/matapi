import { describe, expect, it, vi } from 'vitest';
import type { PendingDriveConnection } from '../../../src/archive/application/use-cases/begin-drive-connection.use-case';
import { DriveSetupExpiredError } from '../../../src/archive/domain/errors/drive-setup-expired.error';
import {
  DriveSetupStateRegistry,
  type DriveSetupGenerationIdentity,
  type DriveSetupIdentity,
} from '../../../src/telegram/interfaces/drive-setup-state.registry';

describe('DriveSetupStateRegistry', () => {
  it('allows two preparations but claims each exact receipt only once', () => {
    const registry = setupRegistry(1_000);
    registry.prepare({ userId: 1, chatId: 1, receiptId: 'aaaaaaaaaaaaaaaa', preparationExpiresAtMs: 20_000 });
    registry.prepare({ userId: 2, chatId: 2, receiptId: 'bbbbbbbbbbbbbbbb', preparationExpiresAtMs: 20_000 });

    const first = registry.claimAuthorizing(identity(1, 'aaaaaaaaaaaaaaaa'), pending('generation-one'));

    expect(first?.kind).toBe('authorizing');
    expect(registry.claimAuthorizing(identity(1, 'aaaaaaaaaaaaaaaa'), pending('generation-two'))).toBeNull();
    expect(registry.association({ userId: 2, chatId: 2 })?.kind).toBe('preparing');
  });

  it('projects preparation inputs to the declared secret-free state fields', () => {
    const registry = setupRegistry(1_000);
    const input = {
      ...identity(1),
      preparationExpiresAtMs: 20_000,
      document: 'client-document-secret',
      clientSecret: 'client-secret',
    };

    registry.prepare(input);

    const state = registry.association({ userId: 1, chatId: 1 });
    expect(state).not.toHaveProperty('document');
    expect(state).not.toHaveProperty('clientSecret');
  });

  it('projects pending metadata to the declared secret-free authorization fields', () => {
    const registry = setupRegistry(1_000);
    registry.prepare({ ...identity(1), preparationExpiresAtMs: 20_000 });
    const pendingWithSecrets = {
      ...pending('generation-one'),
      providerUrl: 'https://provider.example/device',
      deviceCode: 'device-code-secret',
      accessToken: 'access-token-secret',
    };

    registry.claimAuthorizing(identity(1), pendingWithSecrets);

    const state = registry.association({ userId: 1, chatId: 1 });
    expect(state?.kind).toBe('authorizing');
    expect(state?.kind === 'authorizing' ? state.pending : null).not.toHaveProperty('providerUrl');
    expect(state?.kind === 'authorizing' ? state.pending : null).not.toHaveProperty('deviceCode');
    expect(state?.kind === 'authorizing' ? state.pending : null).not.toHaveProperty('accessToken');
  });

  it.each([
    ['receipt', { receiptId: 'bbbbbbbbbbbbbbbb' }],
    ['admin user', { adminUserId: 2 }],
    ['chat', { chatId: 2 }],
  ] as const)('rejects a pending connection with mismatched %s binding', (_, mismatch) => {
    const registry = setupRegistry(1_000);
    registry.prepare({ ...identity(1), preparationExpiresAtMs: 20_000 });

    expect(registry.claimAuthorizing(identity(1), { ...pending('generation-one'), ...mismatch })).toBeNull();
    expect(registry.association({ userId: 1, chatId: 1 })).toMatchObject({
      kind: 'preparing',
      receiptId: 'aaaaaaaaaaaaaaaa',
    });
  });

  it('rejects replacement before cancellation and only removes an exact preparation', () => {
    const registry = setupRegistry(1_000);
    registry.prepare({ ...identity(1), preparationExpiresAtMs: 20_000 });

    expect(() => registry.prepare({ ...identity(1, 'bbbbbbbbbbbbbbbb'), preparationExpiresAtMs: 20_000 }))
      .toThrow('Drive setup replacement was not cancelled first');
    expect(registry.removePreparation(identity(1, 'bbbbbbbbbbbbbbbb'))).toBe(false);
    expect(registry.removePreparation(identity(1))).toBe(true);
    expect(registry.association({ userId: 1, chatId: 1 })).toBeNull();
  });

  it('expires preparation before it can claim an authorization generation', () => {
    const registry = setupRegistry(20_000);
    registry.prepare({ ...identity(1), preparationExpiresAtMs: 20_000 });

    expect(() => registry.claimAuthorizing(identity(1), pending('generation-one'))).toThrow(DriveSetupExpiredError);
  });

  it('returns only the exact failed generation to preparing', () => {
    const registry = authorizingRegistry();

    expect(registry.returnToPreparing(generationIdentity('wrong-generation'))).toBe(false);
    expect(registry.returnToPreparing(generationIdentity('generation-one'))).toBe(true);
    expect(registry.association({ userId: 1, chatId: 1 })?.kind).toBe('preparing');
  });

  it('records only a live deadline for the exact authorization generation', () => {
    const registry = authorizingRegistry();

    expect(registry.recordChallenge({ ...generationIdentity('wrong'), effectiveDeadlineMs: 9_000 })).toBe(false);
    expect(registry.recordChallenge({ ...generationIdentity('generation-one'), effectiveDeadlineMs: 1_000 })).toBe(false);
    expect(registry.recordChallenge({ ...generationIdentity('generation-one'), effectiveDeadlineMs: 11_001 })).toBe(false);
    expect(registry.recordChallenge({ ...generationIdentity('generation-one'), effectiveDeadlineMs: 9_000 })).toBe(true);
    expect(registry.authorizing(generationIdentity('generation-one'))?.effectiveDeadlineMs).toBe(9_000);
  });

  it('retains successful authorization until the exact terminal outcome takes it', () => {
    const registry = authorizingRegistry();

    expect(registry.observeAuthorized(generationIdentity('generation-one'))?.kind).toBe('authorizing');
    expect(registry.association({ userId: 1, chatId: 1 })?.kind).toBe('authorizing');
    expect(registry.takeTerminal(generationIdentity('generation-one'))?.kind).toBe('authorizing');
    expect(registry.association({ userId: 1, chatId: 1 })).toBeNull();
  });

  it('removes an exact activated authorization generation', () => {
    const registry = authorizingRegistry();

    expect(registry.takeActivated(generationIdentity('generation-one'))?.kind).toBe('authorizing');
    expect(registry.association({ userId: 1, chatId: 1 })).toBeNull();
  });

  it('aborts before cancelling the exact staged generation', async () => {
    const order: string[] = [];
    const cancel = { execute: vi.fn(async () => { order.push('discard'); return 'cancelled' as const; }) };
    const registry = authorizingRegistry(cancel, () => order.push('abort'));

    await expect(registry.cancelExact(identity(1, 'aaaaaaaaaaaaaaaa'))).resolves.toBe('cancelled');
    expect(order).toEqual(['abort', 'discard']);
  });

  it('rejects stale background outcomes without mutating a replacement', async () => {
    const registry = authorizingRegistry();
    await registry.cancelExact(identity(1, 'aaaaaaaaaaaaaaaa'));
    registry.prepare({ userId: 1, chatId: 1, receiptId: 'bbbbbbbbbbbbbbbb', preparationExpiresAtMs: 20_000 });

    expect(registry.takeTerminal(generationIdentity('generation-one', 'aaaaaaaaaaaaaaaa'))).toBeNull();
    expect(registry.association({ userId: 1, chatId: 1 })?.receiptId).toBe('bbbbbbbbbbbbbbbb');
  });

  it('cancels one user without affecting a second user preparation', async () => {
    const registry = setupRegistry(1_000);
    registry.prepare({ ...identity(1), preparationExpiresAtMs: 20_000 });
    registry.prepare({ ...identity(2, 'bbbbbbbbbbbbbbbb'), preparationExpiresAtMs: 20_000 });

    await registry.cancelUser(1);

    expect(registry.association({ userId: 1, chatId: 1 })).toBeNull();
    expect(registry.association({ userId: 2, chatId: 2 })?.receiptId).toBe('bbbbbbbbbbbbbbbb');
  });

  it('starts empty after a registry restart', () => {
    expect(setupRegistry(1_000).association({ userId: 1, chatId: 1 })).toBeNull();
  });
});

function identity(userId: number, receiptId = 'aaaaaaaaaaaaaaaa'): DriveSetupIdentity {
  return { userId, chatId: userId, receiptId };
}

function generationIdentity(
  generationId: string,
  receiptId = 'aaaaaaaaaaaaaaaa',
): DriveSetupGenerationIdentity {
  return { ...identity(1, receiptId), generationId };
}

function pending(generationId: string): PendingDriveConnection {
  return {
    generationId,
    receiptId: 'aaaaaaaaaaaaaaaa',
    adminUserId: 1,
    chatId: 1,
    installationId: 'installation-1',
    createdAtMs: 1_000,
    expiresAtMs: 11_000,
  };
}

function setupRegistry(
  nowMs: number,
  cancel = { execute: vi.fn().mockResolvedValue('cancelled') },
): DriveSetupStateRegistry {
  const drafts = { register: vi.fn() };
  const registry = new DriveSetupStateRegistry({ now: () => new Date(nowMs) }, cancel as never, drafts as never);
  registry.onModuleInit();
  return registry;
}

function authorizingRegistry(
  cancel = { execute: vi.fn().mockResolvedValue('cancelled') },
  onAbort?: () => void,
): DriveSetupStateRegistry {
  const registry = setupRegistry(1_000, cancel);
  registry.prepare({ ...identity(1), preparationExpiresAtMs: 20_000 });
  const state = registry.claimAuthorizing(identity(1), pending('generation-one'))!;
  if (onAbort) state.controller.signal.addEventListener('abort', onAbort, { once: true });
  return registry;
}

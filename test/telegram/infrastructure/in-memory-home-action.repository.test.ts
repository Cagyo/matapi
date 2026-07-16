import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/database/schema';
import type { HomeActionRepositoryPort } from '../../../src/telegram/application/ports/home-action-repository.port';
import { isHomeActionReceipt, type HomeActionReceipt } from '../../../src/telegram/domain/home-action-receipt';
import type { WorkflowReturnReceipt } from '../../../src/telegram/domain/workflow-return';
import { DrizzleHomeActionRepository } from '../../../src/telegram/infrastructure/drizzle-home-action.repository';
import { InMemoryHomeActionRepository } from '../../../src/telegram/infrastructure/in-memory-home-action.repository';
import { InMemoryUserRepository } from '../../../src/telegram/infrastructure/in-memory-user.repository';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const LATER = new Date('2030-01-01T00:01:00.000Z');
const REFRESHED = new Date('2030-01-02T00:00:00.000Z');

function external(id = '1234567890abcdef'): HomeActionReceipt {
  return { id, userId: 100, chatId: 200, kind: 'cleanup-confirmation', sessionToken: 'token-a', status: 'pending', expiresAt: LATER, payload: {} };
}

class FailOnceMap<K, V> extends Map<K, V> {
  private writesBeforeFailure: number | null = null;

  arm(writesBeforeFailure = 0): void {
    this.writesBeforeFailure = writesBeforeFailure;
  }

  override set(key: K, value: V): this {
    super.set(key, value);
    if (this.writesBeforeFailure === null) return this;
    if (this.writesBeforeFailure === 0) {
      this.writesBeforeFailure = null;
      throw new Error('injected workflow write failure');
    }
    this.writesBeforeFailure -= 1;
    return this;
  }
}

interface WorkflowReturnRepositoryHarness {
  repository: HomeActionRepositoryPort;
  countRows(kind: HomeActionReceipt['kind']): Promise<number>;
  injectMalformedWorkflowRow(): Promise<void>;
  failNextWorkflowWrite(): Promise<void>;
  restart?(): Promise<HomeActionRepositoryPort>;
  dispose(): void;
}

function workflowReceipt(
  id = 'AbCdEf0123_-xyZ9',
  overrides: Partial<WorkflowReturnReceipt> = {},
): WorkflowReturnReceipt {
  return {
    id,
    userId: 100,
    chatId: 200,
    kind: 'workflow-return',
    sessionToken: '0123456789abcdef',
    status: 'pending',
    expiresAt: LATER,
    payload: {
      workflow: 'logs',
      phase: 'cancellable',
      originSource: 'captured',
      origin: { kind: 'history' },
    },
    ...overrides,
  };
}

function describeWorkflowReturnRepositoryContract(
  adapter: string,
  createHarness: () => Promise<WorkflowReturnRepositoryHarness> | WorkflowReturnRepositoryHarness,
  options: { supportsRestart?: boolean } = {},
): void {
  describe(`${adapter} workflow-return repository contract`, () => {
    let harness: WorkflowReturnRepositoryHarness;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(() => harness.dispose());

    it('atomically replaces only workflow-return and returns the previous decodable receipt', async () => {
      const first = workflowReceipt();
      const replacement = workflowReceipt('ZyXwVu9876_-tsR5', {
        payload: { ...first.payload, workflow: 'camera' },
      });
      await harness.repository.create({
        id: '1234567890abcdef', userId: 100, chatId: 200, kind: 'cleanup-confirmation',
        sessionToken: 'token-a', status: 'pending', expiresAt: LATER, payload: {},
      });

      await expect(harness.repository.beginWorkflowReturn(first)).resolves.toBeNull();
      await expect(harness.repository.beginWorkflowReturn(replacement)).resolves.toEqual(first);
      await expect(harness.repository.findWorkflowReturn({ userId: 100, chatId: 200, now: NOW }))
        .resolves.toEqual(replacement);
      await expect(harness.countRows('workflow-return')).resolves.toBe(1);
      await expect(harness.countRows('cleanup-confirmation')).resolves.toBe(1);
    });

    it('isolates persisted workflow receipts from nested input and result mutations', async () => {
      const originalTargetId = '123e4567-e89b-12d3-a456-426614174000';
      const receipt = workflowReceipt(undefined, {
        payload: {
          workflow: 'logs',
          phase: 'cancellable',
          originSource: 'captured',
          origin: {
            kind: 'notification-targets',
            page: 2,
            targets: [{ kind: 'sensor', id: originalTargetId }],
          },
        },
      });
      await harness.repository.beginWorkflowReturn(receipt);

      if (receipt.payload.origin.kind !== 'notification-targets') throw new Error('expected target-list origin');
      receipt.payload.origin.targets[0].id = '223e4567-e89b-12d3-a456-426614174000';
      (receipt.payload.origin.targets as { kind: 'sensor' | 'camera'; id: string }[]).push({
        kind: 'camera',
        id: '323e4567-e89b-12d3-a456-426614174000',
      });

      const returned = await harness.repository.findWorkflowReturn({ userId: 100, chatId: 200, now: NOW });
      expect(returned).toMatchObject({
        payload: {
          origin: {
            kind: 'notification-targets',
            targets: [{ kind: 'sensor', id: originalTargetId }],
          },
        },
      });
      if (returned?.payload.origin.kind !== 'notification-targets') throw new Error('expected persisted target-list origin');
      returned.payload.origin.targets[0].id = '423e4567-e89b-12d3-a456-426614174000';
      (returned.payload.origin.targets as { kind: 'sensor' | 'camera'; id: string }[]).push({
        kind: 'camera',
        id: '523e4567-e89b-12d3-a456-426614174000',
      });

      await expect(harness.repository.findWorkflowReturn({ userId: 100, chatId: 200, now: NOW }))
        .resolves.toMatchObject({
          payload: {
            origin: {
              kind: 'notification-targets',
              targets: [{ kind: 'sensor', id: originalTargetId }],
            },
          },
        });
    });

    it('fails closed on malformed rows while allowing atomic replacement', async () => {
      await harness.injectMalformedWorkflowRow();

      await expect(harness.repository.findWorkflowReturn({ userId: 100, chatId: 200, now: NOW }))
        .resolves.toBeNull();
      await expect(harness.repository.claimWorkflowReturn({
        userId: 100, chatId: 200, id: 'AbCdEf0123_-xyZ9', now: NOW,
      })).resolves.toEqual({ kind: 'superseded' });
      await expect(harness.repository.beginWorkflowReturn(workflowReceipt())).resolves.toBeNull();
      await expect(harness.countRows('workflow-return')).resolves.toBe(1);
    });

    it('reports an ID mismatch as superseded for every compare-and-set operation', async () => {
      const current = workflowReceipt();
      await harness.repository.beginWorkflowReturn(current);

      await expect(harness.repository.updateWorkflowReturnPhase({
        userId: 100, chatId: 200, id: 'ZyXwVu9876_-tsR5', phase: 'running', expiresAt: REFRESHED, now: NOW,
      })).resolves.toBe('superseded');
      await expect(harness.repository.claimWorkflowReturn({
        userId: 100, chatId: 200, id: 'ZyXwVu9876_-tsR5', now: NOW,
      })).resolves.toEqual({ kind: 'superseded' });
      await expect(harness.repository.finishWorkflowReturn({
        userId: 100, chatId: 200, id: 'ZyXwVu9876_-tsR5', outcome: 'completed', now: NOW,
      })).resolves.toBe('superseded');
      await expect(harness.repository.findWorkflowReturn({ userId: 100, chatId: 200, now: NOW }))
        .resolves.toEqual(current);
    });

    it('never claims or updates an expired pending receipt', async () => {
      const expired = workflowReceipt(undefined, { expiresAt: NOW });
      await harness.repository.beginWorkflowReturn(expired);

      await expect(harness.repository.claimWorkflowReturn({
        userId: 100, chatId: 200, id: expired.id, now: NOW,
      })).resolves.toEqual({ kind: 'expired' });
      await expect(harness.repository.updateWorkflowReturnPhase({
        userId: 100, chatId: 200, id: expired.id, phase: 'running', expiresAt: REFRESHED, now: NOW,
      })).resolves.toBe('expired');
      await expect(harness.repository.findWorkflowReturn({ userId: 100, chatId: 200, now: NOW }))
        .resolves.toBeNull();
    });

    it('claims pending once and exposes executing as resumable', async () => {
      const pending = workflowReceipt();
      await harness.repository.beginWorkflowReturn(pending);

      const first = await harness.repository.claimWorkflowReturn({
        userId: 100, chatId: 200, id: pending.id, now: NOW,
      });
      expect(first).toEqual({ kind: 'claimed', receipt: { ...pending, status: 'executing' } });
      await expect(harness.repository.claimWorkflowReturn({
        userId: 100, chatId: 200, id: pending.id, now: NOW,
      })).resolves.toEqual({ kind: 'resumable', receipt: { ...pending, status: 'executing' } });
    });

    it('keeps returned observable until completion and treats completed as terminal', async () => {
      const pending = workflowReceipt();
      await harness.repository.beginWorkflowReturn(pending);
      await harness.repository.claimWorkflowReturn({ userId: 100, chatId: 200, id: pending.id, now: NOW });

      await expect(harness.repository.finishWorkflowReturn({
        userId: 100, chatId: 200, id: pending.id, outcome: 'returned', now: NOW,
      })).resolves.toBe('finished');
      await expect(harness.repository.claimWorkflowReturn({
        userId: 100, chatId: 200, id: pending.id, now: NOW,
      })).resolves.toEqual({ kind: 'returned', receipt: { ...pending, status: 'returned' } });
      await expect(harness.repository.finishWorkflowReturn({
        userId: 100, chatId: 200, id: pending.id, outcome: 'completed', now: NOW,
      })).resolves.toBe('finished');
      await expect(harness.repository.claimWorkflowReturn({
        userId: 100, chatId: 200, id: pending.id, now: NOW,
      })).resolves.toEqual({ kind: 'terminal' });
      await expect(harness.repository.finishWorkflowReturn({
        userId: 100, chatId: 200, id: pending.id, outcome: 'completed', now: NOW,
      })).resolves.toBe('terminal');
    });

    it('refreshes the 24-hour expiry only after a valid pending phase update', async () => {
      const pending = workflowReceipt();
      await harness.repository.beginWorkflowReturn(pending);

      await expect(harness.repository.updateWorkflowReturnPhase({
        userId: 100, chatId: 200, id: 'ZyXwVu9876_-tsR5', phase: 'running', expiresAt: REFRESHED, now: NOW,
      })).resolves.toBe('superseded');
      await expect(harness.repository.findWorkflowReturn({ userId: 100, chatId: 200, now: NOW }))
        .resolves.toMatchObject({ expiresAt: LATER, payload: { phase: 'cancellable' } });

      await expect(harness.repository.updateWorkflowReturnPhase({
        userId: 100, chatId: 200, id: pending.id, phase: 'running', expiresAt: REFRESHED, now: NOW,
      })).resolves.toBe('updated');
      await expect(harness.repository.findWorkflowReturn({ userId: 100, chatId: 200, now: NOW }))
        .resolves.toMatchObject({ expiresAt: REFRESHED, payload: { phase: 'running' } });

      await harness.repository.claimWorkflowReturn({ userId: 100, chatId: 200, id: pending.id, now: NOW });
      await expect(harness.repository.updateWorkflowReturnPhase({
        userId: 100, chatId: 200, id: pending.id, phase: 'cancellable',
        expiresAt: new Date(REFRESHED.getTime() + 86_400_000), now: NOW,
      })).resolves.toBe('terminal');
      await expect(harness.repository.findWorkflowReturn({ userId: 100, chatId: 200, now: NOW }))
        .resolves.toMatchObject({ expiresAt: REFRESHED, payload: { phase: 'running' } });
    });

    it('serializes concurrent claims into one claimed and one resumable result', async () => {
      const pending = workflowReceipt();
      await harness.repository.beginWorkflowReturn(pending);

      const results = await Promise.all([
        harness.repository.claimWorkflowReturn({ userId: 100, chatId: 200, id: pending.id, now: NOW }),
        harness.repository.claimWorkflowReturn({ userId: 100, chatId: 200, id: pending.id, now: NOW }),
      ]);

      expect(results.map((result) => result.kind).sort()).toEqual(['claimed', 'resumable']);
    });

    it('rolls back replacement when an injected write failure occurs', async () => {
      const first = workflowReceipt();
      await harness.repository.beginWorkflowReturn(first);
      await harness.failNextWorkflowWrite();

      await expect(harness.repository.beginWorkflowReturn(workflowReceipt('ZyXwVu9876_-tsR5')))
        .rejects.toThrow(/injected workflow write failure/);
      await expect(harness.repository.findWorkflowReturn({ userId: 100, chatId: 200, now: NOW }))
        .resolves.toEqual(first);
      await expect(harness.countRows('workflow-return')).resolves.toBe(1);
    });

    if (options.supportsRestart) {
      it('reads back an in-flight receipt after an adapter restart', async () => {
        const pending = workflowReceipt();
        await harness.repository.beginWorkflowReturn(pending);
        await harness.repository.updateWorkflowReturnPhase({
          userId: 100, chatId: 200, id: pending.id, phase: 'running', expiresAt: REFRESHED, now: NOW,
        });
        await harness.repository.claimWorkflowReturn({ userId: 100, chatId: 200, id: pending.id, now: NOW });

        const restarted = await harness.restart?.();
        if (!restarted) throw new Error('restart support was declared without a restart implementation');
        await expect(restarted.findWorkflowReturn({ userId: 100, chatId: 200, now: NOW }))
          .resolves.toMatchObject({ id: pending.id, status: 'executing', expiresAt: REFRESHED, payload: { phase: 'running' } });
        await expect(restarted.claimWorkflowReturn({ userId: 100, chatId: 200, id: pending.id, now: NOW }))
          .resolves.toMatchObject({ kind: 'resumable', receipt: { id: pending.id, status: 'executing' } });
      });
    }
  });
}

describeWorkflowReturnRepositoryContract('DrizzleHomeActionRepository', () => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './migrations' });
  sqlite.prepare('INSERT INTO users (telegram_id, name, role, locale) VALUES (?, ?, ?, ?)')
    .run(100, 'User', 'user', 'en');
  const repository = new DrizzleHomeActionRepository(db);
  return {
    repository,
    countRows: async (kind) => {
      const row = sqlite.prepare('SELECT count(*) AS count FROM home_action_receipts WHERE kind = ?')
        .get(kind) as { count: number };
      return row.count;
    },
    injectMalformedWorkflowRow: async () => {
      sqlite.prepare(`INSERT INTO home_action_receipts
        (user_id, chat_id, kind, id, session_token, status, payload, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        100, 200, 'workflow-return', 'AbCdEf0123_-xyZ9', null, 'pending',
        '{malformed', LATER.getTime() / 1_000, NOW.getTime() / 1_000,
      );
    },
    failNextWorkflowWrite: async () => {
      sqlite.exec(`CREATE TRIGGER fail_workflow_write
        BEFORE UPDATE ON home_action_receipts
        WHEN OLD.kind = 'workflow-return'
        BEGIN SELECT RAISE(ABORT, 'injected workflow write failure'); END`);
    },
    restart: async () => new DrizzleHomeActionRepository(drizzle(sqlite, { schema })),
    dispose: () => sqlite.close(),
  } satisfies WorkflowReturnRepositoryHarness;
}, { supportsRestart: true });

describeWorkflowReturnRepositoryContract('InMemoryHomeActionRepository', () => {
  const repository = new InMemoryHomeActionRepository();
  const storage = new FailOnceMap<string, unknown>();
  (repository as unknown as { receipts: Map<string, unknown> }).receipts = storage;
  return {
    repository,
    countRows: async (kind) => [...storage.values()].filter((receipt) => (
      typeof receipt === 'object' && receipt !== null && 'kind' in receipt && receipt.kind === kind
    )).length,
    injectMalformedWorkflowRow: async () => {
      storage.set('100:200:workflow-return', {
        id: 'AbCdEf0123_-xyZ9', userId: 100, chatId: 200, kind: 'workflow-return',
        sessionToken: null, status: 'pending', expiresAt: LATER, payload: '{malformed',
      });
    },
    failNextWorkflowWrite: async () => storage.arm(),
    dispose: () => undefined,
  } satisfies WorkflowReturnRepositoryHarness;
});

describe('InMemoryHomeActionRepository workflow-return transaction isolation', () => {
  it('rolls back a failed replacement before overlapping reads and replacements run', async () => {
    const repository = new InMemoryHomeActionRepository();
    const storage = new FailOnceMap<string, HomeActionReceipt>();
    (repository as unknown as { receipts: Map<string, HomeActionReceipt> }).receipts = storage;
    const first = workflowReceipt();
    const failed = workflowReceipt('ZyXwVu9876_-tsR5');
    const successful = workflowReceipt('LmNoPq4567_-hIj8', {
      payload: { ...first.payload, workflow: 'camera' },
    });
    await repository.beginWorkflowReturn(first);
    storage.arm();

    const failure = expect(repository.beginWorkflowReturn(failed))
      .rejects.toThrow(/injected workflow write failure/);
    const overlappingRead = repository.findWorkflowReturn({ userId: 100, chatId: 200, now: NOW });
    const overlappingReplacement = repository.beginWorkflowReturn(successful);

    await failure;
    await expect(overlappingRead).resolves.toEqual(first);
    await expect(overlappingReplacement).resolves.toEqual(first);
    await expect(repository.findWorkflowReturn({ userId: 100, chatId: 200, now: NOW }))
      .resolves.toEqual(successful);
  });

  it('rolls back earlier receipt mutations when an async notification transaction later rejects', async () => {
    const users = new InMemoryUserRepository([{
      telegramId: 100, name: 'Ada', role: 'user', locale: 'en', muted: false,
      nonCriticalPausedUntil: null, notificationPauseRevision: 0,
      quietStart: null, quietEnd: null, createdAt: null,
    }]);
    const repository = new InMemoryHomeActionRepository(users);
    const storage = new FailOnceMap<string, HomeActionReceipt>();
    (repository as unknown as { receipts: Map<string, HomeActionReceipt> }).receipts = storage;
    await repository.createPauseConfirmation({
      id: '1234567890abcdef', userId: 100, chatId: 200, kind: 'pause-confirmation',
      sessionToken: 'token-a', status: 'pending', expiresAt: LATER, payload: { hours: 4 },
    });
    storage.arm(1);

    await expect(repository.confirmPause({
      userId: 100, chatId: 200, token: 'token-a', id: '1234567890abcdef', hours: 4, now: NOW,
    })).rejects.toThrow(/injected workflow write failure/);

    await expect(repository.findCurrentUndo({
      userId: 100, chatId: 200, kind: 'undo-non-critical-pause', now: NOW,
    })).resolves.toBeNull();
    await expect(users.getNotificationPauseState(100)).resolves.toMatchObject({
      revision: 0,
      nonCriticalPausedUntil: null,
    });
    await expect(repository.confirmPause({
      userId: 100, chatId: 200, token: 'token-a', id: '1234567890abcdef', hours: 4, now: NOW,
    })).resolves.toMatchObject({ kind: 'applied', expectedRevision: 1 });
  });
});

describe('InMemoryHomeActionRepository', () => {
  it('rejects mismatched confirmation and undo receipt payloads at the boundary', () => {
    expect(isHomeActionReceipt({ ...external(), sessionToken: null })).toBe(false);
    expect(isHomeActionReceipt({ ...external(), payload: { hours: 4 } })).toBe(false);
    expect(isHomeActionReceipt({ id: '1234567890abcdef', userId: 100, chatId: 200, kind: 'undo-non-critical-pause', sessionToken: null, status: 'pending', expiresAt: LATER, payload: { foundationReceiptId: 7 } })).toBe(false);
  });

  it('replaces only the same receipt kind and claims an exact pending external action once', async () => {
    const repository = new InMemoryHomeActionRepository();
    await repository.create(external());
    await repository.create({ ...external('abcdef1234567890'), kind: 'restart-confirmation' });
    await repository.create(external('0011223344556677'));

    await expect(repository.claimExternal({ userId: 100, chatId: 200, token: 'token-a', kind: 'cleanup-confirmation', id: '1234567890abcdef', now: NOW })).resolves.toEqual({ kind: 'superseded' });
    const claimed = await repository.claimExternal({ userId: 100, chatId: 200, token: 'token-a', kind: 'cleanup-confirmation', id: '0011223344556677', now: NOW });
    expect(claimed).toEqual({ kind: 'claimed', action: { id: '0011223344556677', userId: 100, chatId: 200, kind: 'cleanup-confirmation' } });
    await expect(repository.claimExternal({ userId: 100, chatId: 200, token: 'token-a', kind: 'cleanup-confirmation', id: '0011223344556677', now: NOW })).resolves.toEqual({ kind: 'executing' });
  });

  it('rejects invalid claims, honours the expiry boundary, and records terminal completion', async () => {
    const repository = new InMemoryHomeActionRepository();
    await repository.create(external());
    await expect(repository.claimExternal({ userId: 100, chatId: 200, token: 'wrong', kind: 'cleanup-confirmation', id: '1234567890abcdef', now: NOW })).resolves.toEqual({ kind: 'superseded' });
    await expect(repository.claimExternal({ userId: 100, chatId: 200, token: 'token-a', kind: 'cleanup-confirmation', id: 'wrong', now: NOW })).resolves.toEqual({ kind: 'superseded' });
    await expect(repository.claimExternal({ userId: 100, chatId: 200, token: 'token-a', kind: 'cleanup-confirmation', id: '1234567890abcdef', now: LATER })).resolves.toEqual({ kind: 'expired' });

    await repository.create(external());
    const result = await repository.claimExternal({ userId: 100, chatId: 200, token: 'token-a', kind: 'cleanup-confirmation', id: '1234567890abcdef', now: NOW });
    if (result.kind !== 'claimed') throw new Error('expected claimed action');
    await repository.finishExternal({ action: result.action, outcome: 'completed', now: NOW });
    await expect(repository.claimExternal({ userId: 100, chatId: 200, token: 'token-a', kind: 'cleanup-confirmation', id: '1234567890abcdef', now: NOW })).resolves.toEqual({ kind: 'terminal' });
  });

  it('finds only an unexpired pending current undo receipt', async () => {
    const repository = new InMemoryHomeActionRepository();
    const undo: HomeActionReceipt = { id: '1234567890abcdef', userId: 100, chatId: 200, kind: 'undo-non-critical-pause', sessionToken: null, status: 'pending', expiresAt: LATER, payload: { foundationReceiptId: 7, expectedRevision: 3 } };
    await repository.create(undo);
    await expect(repository.findCurrentUndo({ userId: 100, chatId: 200, kind: 'undo-non-critical-pause', now: NOW })).resolves.toEqual(undo);
    await expect(repository.findCurrentUndo({ userId: 100, chatId: 200, kind: 'undo-non-critical-pause', now: LATER })).resolves.toBeNull();
  });

  it('commits a confirmed pause, its foundation receipt, and its Home undo together', async () => {
    const users = new InMemoryUserRepository([{
      telegramId: 100, name: 'Ada', role: 'user', locale: 'en', muted: false,
      nonCriticalPausedUntil: null, notificationPauseRevision: 0,
      quietStart: null, quietEnd: null, createdAt: null,
    }]);
    const repository = new InMemoryHomeActionRepository(users);
    await repository.createPauseConfirmation({
      id: '1234567890abcdef', userId: 100, chatId: 200, kind: 'pause-confirmation',
      sessionToken: 'token-a', status: 'pending', expiresAt: new Date(NOW.getTime() + 120_000),
      payload: { hours: 4 },
    });

    await expect(repository.confirmPause({
      userId: 100, chatId: 200, token: 'token-a', id: '1234567890abcdef', hours: 4, now: NOW,
    })).resolves.toMatchObject({ kind: 'applied', expectedRevision: 1 });
    expect(await users.getNotificationPauseState(100)).toMatchObject({ revision: 1 });
    await expect(repository.findCurrentUndo({
      userId: 100, chatId: 200, kind: 'undo-non-critical-pause', now: NOW,
    })).resolves.toMatchObject({ kind: 'undo-non-critical-pause', payload: { expectedRevision: 1 } });
  });

  it.each([1, 4, 8] as const)('allows the %ih pause Undo immediately before its deadline and rejects it at the deadline', async (hours) => {
    const createRepository = () => {
      const users = new InMemoryUserRepository([{
        telegramId: 100, name: 'Ada', role: 'user', locale: 'en', muted: false,
        nonCriticalPausedUntil: null, notificationPauseRevision: 0,
        quietStart: null, quietEnd: null, createdAt: null,
      }]);
      return { users, repository: new InMemoryHomeActionRepository(users) };
    };
    const deadline = new Date(NOW.getTime() + hours * 3_600_000);

    const before = createRepository();
    await before.repository.createPauseConfirmation({
      id: '1234567890abcdef', userId: 100, chatId: 200, kind: 'pause-confirmation',
      sessionToken: 'token-a', status: 'pending', payload: { hours }, expiresAt: new Date(NOW.getTime() + 120_000),
    });
    await expect(before.repository.confirmPause({ userId: 100, chatId: 200, token: 'token-a', id: '1234567890abcdef', hours, now: NOW }))
      .resolves.toMatchObject({ kind: 'applied' });
    await expect(before.repository.undoPause({ userId: 100, chatId: 200, id: '1234567890abcdef', now: new Date(deadline.getTime() - 1) }))
      .resolves.toEqual({ kind: 'applied' });

    const exact = createRepository();
    await exact.repository.createPauseConfirmation({
      id: '1234567890abcdef', userId: 100, chatId: 200, kind: 'pause-confirmation',
      sessionToken: 'token-a', status: 'pending', payload: { hours }, expiresAt: new Date(NOW.getTime() + 120_000),
    });
    await exact.repository.confirmPause({ userId: 100, chatId: 200, token: 'token-a', id: '1234567890abcdef', hours, now: NOW });
    await expect(exact.repository.undoPause({ userId: 100, chatId: 200, id: '1234567890abcdef', now: deadline }))
      .resolves.toEqual({ kind: 'expired' });
    await expect(exact.users.getNotificationPauseState(100)).resolves.toMatchObject({ nonCriticalPausedUntil: deadline });
  });
});

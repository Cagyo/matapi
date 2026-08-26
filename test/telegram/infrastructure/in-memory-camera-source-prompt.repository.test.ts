import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/database/schema';
import type {
  CameraSourcePromptRepositoryPort,
} from '../../../src/telegram/application/ports/camera-source-prompt-repository.port';
import {
  CAMERA_SOURCE_ABANDONED_TTL_MS,
  CAMERA_SOURCE_PROMPT_TTL_MS,
  CAMERA_SOURCE_TOMBSTONE_TTL_MS,
  createCameraSourcePrompt,
  type CameraSourcePrompt,
  type NewCameraSourcePrompt,
} from '../../../src/telegram/domain/camera-source-prompt';
import { DrizzleCameraSourcePromptRepository } from '../../../src/telegram/infrastructure/drizzle-camera-source-prompt.repository';
import { InMemoryCameraSourcePromptRepository } from '../../../src/telegram/infrastructure/in-memory-camera-source-prompt.repository';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const ADMIN = 100;
const CHAT = 200;
const RECEIPT = '1234567890abcdef';
const SECRET_URL = 'rtsp://operator:hunter2@cam.local/stream1';

/**
 * The stored row as the adapter actually holds it, normalized so a SQLite row
 * and a `Map` entry are directly comparable — and so a secret in either one is
 * visible to the assertion rather than hidden behind the adapter's decode.
 */
interface StoredPrompt {
  userId: number;
  chatId: number;
  receiptId: string;
  promptMessageId: number;
  replyMessageId: number | null;
  phase: string;
  operation: string;
  cameraId: string | null;
  displayName: string | null;
  expectedRevision: number | null;
  status: string;
  deletionFailed: boolean;
  expiresAt: number;
  retainUntil: number | null;
}

/** Raw SQLite column values, before the harness normalizes them. */
type SqliteValue = Record<string, string | number | null>;

interface CameraSourcePromptHarness {
  repository: CameraSourcePromptRepositoryPort;
  seedAdministrator(userId: number): void;
  stored(): readonly StoredPrompt[];
  dispose(): void;
}

function draft(overrides: Partial<NewCameraSourcePrompt> = {}): NewCameraSourcePrompt {
  return {
    userId: ADMIN,
    chatId: CHAT,
    receiptId: RECEIPT,
    promptMessageId: 90,
    phase: 'credential',
    operation: 'create',
    cameraId: null,
    displayName: 'Front Door',
    expectedRevision: null,
    createdAt: NOW,
    ...overrides,
  };
}

function pending(overrides: Partial<NewCameraSourcePrompt> = {}): CameraSourcePrompt {
  return createCameraSourcePrompt(draft(overrides));
}

function identityOf(prompt: CameraSourcePrompt) {
  return {
    userId: prompt.userId,
    chatId: prompt.chatId,
    receiptId: prompt.receiptId,
    promptMessageId: prompt.promptMessageId,
  };
}

function after(milliseconds: number): Date {
  return new Date(NOW.getTime() + milliseconds);
}

function sortStored(rows: readonly StoredPrompt[]): StoredPrompt[] {
  return [...rows].sort(
    (left, right) =>
      left.userId - right.userId
      || (left.receiptId < right.receiptId ? -1 : left.receiptId > right.receiptId ? 1 : 0)
      || left.promptMessageId - right.promptMessageId,
  );
}

function drizzleHarness(): CameraSourcePromptHarness {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: './migrations' });

  return {
    repository: new DrizzleCameraSourcePromptRepository(db),
    seedAdministrator: (userId) =>
      void sqlite
        .prepare('INSERT INTO users (telegram_id, name, role) VALUES (?, ?, ?)')
        .run(userId, `admin-${userId}`, 'admin'),
    stored: () =>
      sortStored(
        (sqlite.prepare('SELECT * FROM telegram_camera_source_prompts').all() as SqliteValue[]).map(
          (row) => ({
            userId: Number(row.user_id),
            chatId: Number(row.chat_id),
            receiptId: String(row.receipt_id),
            promptMessageId: Number(row.prompt_message_id),
            replyMessageId: row.reply_message_id === null ? null : Number(row.reply_message_id),
            phase: String(row.phase),
            operation: String(row.operation),
            cameraId: row.camera_id === null ? null : String(row.camera_id),
            displayName: row.display_name === null ? null : String(row.display_name),
            expectedRevision: row.expected_revision === null ? null : Number(row.expected_revision),
            status: String(row.status),
            deletionFailed: row.deletion_failed === 1,
            expiresAt: Number(row.expires_at),
            retainUntil: row.retain_until === null ? null : Number(row.retain_until),
          }),
        ),
      ),
    dispose: () => sqlite.close(),
  };
}

function inMemoryHarness(): CameraSourcePromptHarness {
  const repository = new InMemoryCameraSourcePromptRepository();
  // The `Map` is this adapter's whole durable state; reading it directly is the
  // in-memory equivalent of the SQLite harness's `SELECT *`.
  const state = repository as unknown as { prompts: Map<string, CameraSourcePrompt> };

  return {
    repository,
    seedAdministrator: () => undefined,
    stored: () =>
      sortStored(
        [...state.prompts.values()].map((prompt) => ({
          ...prompt,
          expiresAt: prompt.expiresAt.getTime(),
          retainUntil: prompt.retainUntil === null ? null : prompt.retainUntil.getTime(),
        })),
      ),
    dispose: () => undefined,
  };
}

function describeCameraSourcePromptContract(
  adapter: string,
  createHarness: () => CameraSourcePromptHarness,
): void {
  describe(`${adapter} camera source prompt contract`, () => {
    let harness: CameraSourcePromptHarness;
    let repository: CameraSourcePromptRepositoryPort;

    beforeEach(() => {
      harness = createHarness();
      repository = harness.repository;
      harness.seedAdministrator(ADMIN);
    });

    afterEach(() => harness.dispose());

    async function seedPending(overrides: Partial<NewCameraSourcePrompt> = {}): Promise<CameraSourcePrompt> {
      const prompt = pending(overrides);
      await repository.createPending(prompt);
      return prompt;
    }

    describe('createPending', () => {
      it('stores exactly the non-secret prompt it was given', async () => {
        const prompt = await seedPending();

        expect(harness.stored()).toEqual([
          {
            userId: ADMIN,
            chatId: CHAT,
            receiptId: RECEIPT,
            promptMessageId: 90,
            replyMessageId: null,
            phase: 'credential',
            operation: 'create',
            cameraId: null,
            displayName: 'Front Door',
            expectedRevision: null,
            status: 'pending',
            deletionFailed: false,
            expiresAt: prompt.expiresAt.getTime(),
            retainUntil: null,
          },
        ]);
        expect(prompt.expiresAt.getTime() - NOW.getTime()).toBe(CAMERA_SOURCE_PROMPT_TTL_MS);
      });

      it.each([
        ['a secret-bearing display name', { displayName: SECRET_URL }],
        ['a secret-bearing camera identifier', { cameraId: SECRET_URL, displayName: null }],
        ['a group chat', { chatId: -1_001_234_567_890 }],
        ['a malformed receipt', { receiptId: 'nope' }],
      ])('refuses %s and writes nothing', async (_label, overrides) => {
        await expect(repository.createPending({ ...pending(), ...overrides }))
          .rejects.toThrow(RangeError);
        expect(harness.stored()).toEqual([]);
      });

      it('refuses a value carrying a field the model does not publish', async () => {
        const smuggled = { ...pending(), url: SECRET_URL } as unknown as CameraSourcePrompt;

        await expect(repository.createPending(smuggled)).rejects.toThrow(RangeError);
        expect(harness.stored()).toEqual([]);
      });

      it.each([
        ['already running', { status: 'running' as const, replyMessageId: 91 }],
        ['already answered', { replyMessageId: 91 }],
        ['already retained', { status: 'consumed' as const, retainUntil: NOW }],
        ['carrying a deletion failure', { deletionFailed: true }],
      ])('refuses a prompt that is %s', async (_label, overrides) => {
        await expect(repository.createPending({ ...pending(), ...overrides }))
          .rejects.toThrow(RangeError);
        expect(harness.stored()).toEqual([]);
      });

      it('reports a duplicate identity identically in either adapter', async () => {
        await seedPending();

        const failure = await repository.createPending(pending())
          .then(() => null, (error: unknown) => error);

        expect(failure).toBeInstanceOf(RangeError);
        const message = (failure as Error).message;
        expect(message).toMatch(/already exists/);
        // The SQLite adapter must not leak its constraint text or column list.
        expect(message).not.toMatch(/UNIQUE|constraint|telegram_camera_source_prompts/i);
        expect(harness.stored()).toHaveLength(1);
      });
    });

    describe('claimReply', () => {
      it('claims the exact reply once and records the reply message durably', async () => {
        const prompt = await seedPending();

        await expect(repository.claimReply({
          ...identityOf(prompt),
          replyMessageId: 91,
          now: after(5 * 60_000),
        })).resolves.toEqual({
          kind: 'claimed',
          prompt: { ...prompt, status: 'running', replyMessageId: 91 },
        });
        expect(harness.stored()[0]).toMatchObject({ status: 'running', replyMessageId: 91 });
      });

      it('answers a duplicate claim with late, leaving the first claim intact', async () => {
        const prompt = await seedPending();
        await repository.claimReply({ ...identityOf(prompt), replyMessageId: 91, now: after(1_000) });

        const second = await repository.claimReply({
          ...identityOf(prompt),
          replyMessageId: 92,
          now: after(2_000),
        });

        expect(second).toEqual({
          kind: 'late',
          prompt: { ...prompt, status: 'running', replyMessageId: 91 },
        });
        expect(harness.stored()[0]).toMatchObject({ status: 'running', replyMessageId: 91 });
      });

      it.each([
        ['another administrator', { userId: 8, chatId: 208 }],
        ['another receipt', { receiptId: 'fedcba0987654321' }],
        ['another prompt message', { promptMessageId: 99 }],
        ['another chat of the same administrator', { chatId: 999 }],
      ])('answers a reply bound to %s with stale', async (_label, overrides) => {
        const prompt = await seedPending();

        await expect(repository.claimReply({
          ...identityOf(prompt),
          ...overrides,
          replyMessageId: 91,
          now: after(1_000),
        })).resolves.toEqual({ kind: 'stale' });
        expect(harness.stored()[0]).toMatchObject({ status: 'pending', replyMessageId: null });
      });

      it('answers a reply to nothing at all with stale', async () => {
        await expect(repository.claimReply({
          userId: ADMIN,
          chatId: CHAT,
          receiptId: RECEIPT,
          promptMessageId: 90,
          replyMessageId: 91,
          now: NOW,
        })).resolves.toEqual({ kind: 'stale' });
      });

      it('claims strictly before the deadline and is late at the deadline itself', async () => {
        const prompt = await seedPending();

        await expect(repository.claimReply({
          ...identityOf(prompt),
          replyMessageId: 91,
          now: new Date(prompt.expiresAt.getTime()),
        })).resolves.toMatchObject({ kind: 'late' });
        expect(harness.stored()[0]).toMatchObject({ status: 'pending', replyMessageId: null });

        await expect(repository.claimReply({
          ...identityOf(prompt),
          replyMessageId: 91,
          now: new Date(prompt.expiresAt.getTime() - 1),
        })).resolves.toMatchObject({ kind: 'claimed' });
      });

      it('returns the retained prompt so a late reply can still be cleaned up', async () => {
        const prompt = await seedPending();
        await repository.claimReply({ ...identityOf(prompt), replyMessageId: 91, now: after(1_000) });
        await repository.consume({
          identity: identityOf(prompt),
          deletionFailed: false,
          now: after(2_000),
        });

        await expect(repository.claimReply({
          ...identityOf(prompt),
          replyMessageId: 93,
          now: after(3_000),
        })).resolves.toMatchObject({ kind: 'late', prompt: { status: 'consumed', phase: 'credential' } });
      });

      it.each([
        ['a reply message that is not a Telegram message', { replyMessageId: 0 }],
        ['a group-shaped chat', { chatId: -1_001_234_567_890 }],
        ['a malformed receipt', { receiptId: 'nope' }],
      ])('refuses %s before it touches a row', async (_label, overrides) => {
        const prompt = await seedPending();

        await expect(repository.claimReply({
          ...identityOf(prompt),
          replyMessageId: 91,
          now: after(1_000),
          ...overrides,
        })).rejects.toThrow(RangeError);
        expect(harness.stored()[0]).toMatchObject({ status: 'pending', replyMessageId: null });
      });

      it('refuses a malformed reply on the stale path, where nothing downstream would', async () => {
        // No prompt is stored, so the claim never reaches the branch that builds
        // a running prompt. Without an up-front guard this returns `stale` and
        // the caller's bug is swallowed.
        await expect(repository.claimReply({
          userId: ADMIN,
          chatId: CHAT,
          receiptId: RECEIPT,
          promptMessageId: 90,
          replyMessageId: 0,
          now: after(1_000),
        })).rejects.toThrow(/reply message/);
      });

      it('refuses a malformed reply on the late path too', async () => {
        const prompt = await seedPending();
        await repository.claimReply({ ...identityOf(prompt), replyMessageId: 91, now: after(1_000) });

        // Already running, so the claim short-circuits to `late` before any
        // prompt is constructed — again past every downstream assertion.
        await expect(repository.claimReply({
          ...identityOf(prompt),
          replyMessageId: 0,
          now: after(2_000),
        })).rejects.toThrow(/reply message/);
      });

      it('refuses a broken clock rather than reading every prompt as late', async () => {
        const prompt = await seedPending();

        // NaN < expiresAt is false, so without an up-front guard a stopped clock
        // would silently report late and the prompt could never be claimed.
        await expect(repository.claimReply({
          ...identityOf(prompt),
          replyMessageId: 91,
          now: new Date(Number.NaN),
        })).rejects.toThrow(/claim instant/);
        expect(harness.stored()[0]).toMatchObject({ status: 'pending' });
      });
    });

    describe('consume and expire', () => {
      it('retains a consumed credential prompt for exactly 24 hours', async () => {
        const prompt = await seedPending();
        const claim = await repository.claimReply({ ...identityOf(prompt), replyMessageId: 91, now: after(1_000) });
        if (claim.kind !== 'claimed') throw new Error('expected a claimed prompt');

        await repository.consume({ identity: identityOf(claim.prompt), deletionFailed: true, now: after(2_000) });

        expect(harness.stored()).toEqual([
          expect.objectContaining({
            status: 'consumed',
            deletionFailed: true,
            replyMessageId: 91,
            retainUntil: after(2_000).getTime() + CAMERA_SOURCE_TOMBSTONE_TTL_MS,
          }),
        ]);
      });

      it('retains an expired credential prompt the same way', async () => {
        const prompt = await seedPending();

        await repository.expire({ identity: identityOf(prompt), deletionFailed: false, now: after(2_000) });

        expect(harness.stored()).toEqual([
          expect.objectContaining({
            status: 'expired',
            deletionFailed: false,
            retainUntil: after(2_000).getTime() + CAMERA_SOURCE_TOMBSTONE_TTL_MS,
          }),
        ]);
      });

      it.each(['consume', 'expire'] as const)('removes a name prompt outright on %s', async (outcome) => {
        const prompt = await seedPending({ phase: 'name', displayName: null });

        await repository[outcome]({ identity: identityOf(prompt), deletionFailed: false, now: after(2_000) });

        expect(harness.stored()).toEqual([]);
      });

      it('measures retention from the first terminal transition, not the latest', async () => {
        const prompt = await seedPending();
        await repository.consume({ identity: identityOf(prompt), deletionFailed: false, now: after(2_000) });
        const first = harness.stored()[0].retainUntil;

        await repository.consume({
          identity: identityOf(prompt),
          deletionFailed: true,
          now: after(9 * 60 * 60_000),
        });

        expect(harness.stored()[0]).toMatchObject({ retainUntil: first, deletionFailed: true });
      });

      it('never clears a standing deletion failure', async () => {
        const prompt = await seedPending();
        await repository.claimReply({ ...identityOf(prompt), replyMessageId: 91, now: after(1_000) });
        await repository.consume({ identity: identityOf(prompt), deletionFailed: true, now: after(2_000) });

        // A later clean pass must not erase the evidence: replyMessageId still
        // names a message that may be sitting in the administrator's chat.
        await repository.consume({ identity: identityOf(prompt), deletionFailed: false, now: after(3_000) });

        expect(harness.stored()[0]).toMatchObject({ deletionFailed: true, replyMessageId: 91 });
      });

      it('records a deletion failure that arrives after a clean one', async () => {
        const prompt = await seedPending();
        await repository.consume({ identity: identityOf(prompt), deletionFailed: false, now: after(2_000) });

        await repository.consume({ identity: identityOf(prompt), deletionFailed: true, now: after(3_000) });

        expect(harness.stored()[0]).toMatchObject({ deletionFailed: true });
      });

      it('keeps the first terminal outcome when a late reply follows', async () => {
        const prompt = await seedPending();
        await repository.consume({ identity: identityOf(prompt), deletionFailed: false, now: after(2_000) });

        // The workflow demonstrably completed; expiry must not overwrite that.
        await repository.expire({ identity: identityOf(prompt), deletionFailed: false, now: after(3_000) });

        expect(harness.stored()[0]).toMatchObject({ status: 'consumed' });
      });

      it('refuses a malformed terminal transition and writes nothing', async () => {
        const prompt = await seedPending();
        const good = { identity: identityOf(prompt), deletionFailed: false, now: after(2_000) };

        await expect(repository.consume({ ...good, identity: { ...good.identity, userId: 0 } }))
          .rejects.toThrow(RangeError);
        await expect(repository.consume({ ...good, deletionFailed: 1 as unknown as boolean }))
          .rejects.toThrow(RangeError);
        await expect(repository.consume({ ...good, now: new Date(Number.NaN) }))
          .rejects.toThrow(RangeError);

        expect(harness.stored()[0]).toMatchObject({ status: 'pending' });
      });

      it('does nothing when the prompt is already gone', async () => {
        await expect(repository.consume({ identity: identityOf(pending()), deletionFailed: false, now: after(2_000) }))
          .resolves.toBeUndefined();
        expect(harness.stored()).toEqual([]);
      });

      it('keeps only the newest 100 tombstones per administrator', async () => {
        harness.seedAdministrator(8);
        await repository.createPending(pending({ userId: 8, chatId: 208, promptMessageId: 500 }));
        await repository.expire({
          identity: identityOf(pending({ userId: 8, chatId: 208, promptMessageId: 500 })),
          deletionFailed: false,
          now: after(1_000),
        });

        // 101 tombstones — one more than the cap allows — retired oldest first,
        // so prompt message 1000 holds the earliest retention deadline and 1100
        // the latest. The count below is a literal on purpose: deriving it from
        // the constant would make any cap value satisfy itself.
        for (let promptMessageId = 1_000; promptMessageId <= 1_100; promptMessageId += 1) {
          const prompt = pending({ promptMessageId });
          await repository.createPending(prompt);
          await repository.expire({
            identity: identityOf(prompt),
            deletionFailed: false,
            now: after((promptMessageId - 1_000) * 1_000),
          });
        }

        const mine = harness.stored().filter((row) => row.userId === ADMIN).map((row) => row.promptMessageId);
        expect(mine).toHaveLength(100);
        // Exactly one record crosses the boundary: the oldest is evicted and the
        // record immediately above it is the new oldest survivor.
        expect(mine).not.toContain(1_000);
        expect(mine).toContain(1_001);
        expect(mine).toContain(1_100);
        expect(Math.min(...mine)).toBe(1_001);
        expect(harness.stored().filter((row) => row.userId === 8)).toHaveLength(1);
      });
    });

    describe('listRunning', () => {
      it('returns interrupted prompts oldest deadline first, bounded by the limit', async () => {
        const second = pending({ promptMessageId: 91, createdAt: after(60_000) });
        const first = pending({ promptMessageId: 90 });
        await repository.createPending(second);
        await repository.createPending(first);
        for (const prompt of [first, second]) {
          await repository.claimReply({ ...identityOf(prompt), replyMessageId: 900, now: after(1_000) });
        }
        await repository.createPending(pending({ promptMessageId: 92 }));

        const running = await repository.listRunning(10);

        expect(running.map((prompt) => prompt.promptMessageId)).toEqual([90, 91]);
        expect(await repository.listRunning(1)).toHaveLength(1);
      });

      it.each([0, -1, 1.5, Number.NaN])('refuses the unusable limit %s', async (limit) => {
        await expect(repository.listRunning(limit)).rejects.toThrow(RangeError);
      });
    });

    describe('prune', () => {
      it('removes a tombstone at its retention deadline and keeps a newer one', async () => {
        const old = pending({ promptMessageId: 90 });
        const fresh = pending({ promptMessageId: 91 });
        await repository.createPending(old);
        await repository.createPending(fresh);
        await repository.expire({ identity: identityOf(old), deletionFailed: false, now: NOW });
        await repository.expire({ identity: identityOf(fresh), deletionFailed: false, now: after(1_000) });

        await repository.prune(new Date(NOW.getTime() + CAMERA_SOURCE_TOMBSTONE_TTL_MS));

        expect(harness.stored().map((row) => row.promptMessageId)).toEqual([91]);
      });

      it('keeps an unanswered prompt for the cleanup window, then removes it', async () => {
        const prompt = await seedPending();
        const horizon = new Date(prompt.expiresAt.getTime() + CAMERA_SOURCE_ABANDONED_TTL_MS);

        await repository.prune(new Date(horizon.getTime() - 1));
        expect(harness.stored()).toHaveLength(1);

        await repository.prune(horizon);
        expect(harness.stored()).toEqual([]);
      });

      it('keeps a prompt that owes a deletion retry until it is abandoned', async () => {
        const prompt = await seedPending();
        await repository.claimReply({ ...identityOf(prompt), replyMessageId: 91, now: after(1_000) });
        const abandoned = new Date(prompt.expiresAt.getTime() + CAMERA_SOURCE_ABANDONED_TTL_MS);

        await repository.prune(new Date(abandoned.getTime() - 1));
        expect(await repository.listRunning(10)).toHaveLength(1);

        // Telegram stops letting a bot delete a message long before this, so the
        // obligation is no longer serviceable and the row must not be immortal.
        await repository.prune(abandoned);
        expect(harness.stored()).toEqual([]);
      });

      it('sweeps an interrupted name prompt, which recovery never terminalises', async () => {
        const prompt = await seedPending({ phase: 'name', displayName: null });
        await repository.claimReply({ ...identityOf(prompt), replyMessageId: 91, now: after(1_000) });

        await repository.prune(new Date(prompt.expiresAt.getTime() + CAMERA_SOURCE_ABANDONED_TTL_MS));

        expect(harness.stored()).toEqual([]);
      });

      it('leaves a live prompt of either status alone', async () => {
        const claimed = await seedPending({ promptMessageId: 90 });
        await repository.createPending(pending({ promptMessageId: 91 }));
        await repository.claimReply({ ...identityOf(claimed), replyMessageId: 91, now: after(1_000) });

        await repository.prune(after(2_000));

        expect(harness.stored()).toHaveLength(2);
      });

      it('refuses an unusable instant', async () => {
        await expect(repository.prune(new Date(Number.NaN))).rejects.toThrow(RangeError);
      });
    });

    it('never lets a credential reach storage through any path', async () => {
      const prompt = await seedPending({ cameraId: 'camera-1' });
      await repository.claimReply({ ...identityOf(prompt), replyMessageId: 91, now: after(1_000) });
      await repository.consume({
        identity: identityOf(prompt),
        deletionFailed: true,
        now: after(2_000),
      });

      expect(JSON.stringify(harness.stored())).not.toMatch(/rtsp|operator|hunter2|cam\.local/i);
    });
  });
}

describeCameraSourcePromptContract('DrizzleCameraSourcePromptRepository', drizzleHarness);
describeCameraSourcePromptContract('InMemoryCameraSourcePromptRepository', inMemoryHarness);

describe('InMemoryCameraSourcePromptRepository', () => {
  it('hands out copies, so a caller cannot mutate stored state through a result', async () => {
    const repository = new InMemoryCameraSourcePromptRepository();
    const prompt = pending();
    await repository.createPending(prompt);
    const claim = await repository.claimReply({
      ...identityOf(prompt),
      replyMessageId: 91,
      now: after(1_000),
    });
    if (claim.kind !== 'claimed') throw new Error('expected a claimed prompt');

    claim.prompt.expiresAt.setTime(0);
    claim.prompt.status = 'consumed';

    const [running] = await repository.listRunning(10);
    expect(running.status).toBe('running');
    expect(running.expiresAt.getTime()).toBe(prompt.expiresAt.getTime());
  });

  it('does not share state between instances', async () => {
    const first = new InMemoryCameraSourcePromptRepository();
    const second = new InMemoryCameraSourcePromptRepository();
    await first.createPending(pending());

    await expect(second.claimReply({
      ...identityOf(pending()),
      replyMessageId: 91,
      now: after(1_000),
    })).resolves.toEqual({ kind: 'stale' });
  });

  it('needs no administrator row, unlike the SQLite adapter', async () => {
    const repository = new InMemoryCameraSourcePromptRepository();

    await expect(repository.createPending(pending({ userId: 4_242, chatId: 4_343 })))
      .resolves.toBeUndefined();
  });
});

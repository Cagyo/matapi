import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/database/schema';
import {
  CAMERA_SOURCE_ABANDONED_TTL_MS,
  CAMERA_SOURCE_TOMBSTONES_PER_ADMIN,
  createCameraSourcePrompt,
  type CameraSourcePrompt,
  type NewCameraSourcePrompt,
} from '../../../src/telegram/domain/camera-source-prompt';
import { DrizzleCameraSourcePromptRepository } from '../../../src/telegram/infrastructure/drizzle-camera-source-prompt.repository';

/**
 * SQLite-specific behaviour only: transaction rollback, table CHECK
 * constraints, the foreign key, and decoding of rows written behind the
 * adapter's back.
 *
 * The port's shared behaviour — claim/consume/expire/listRunning/prune — is
 * governed by `describeCameraSourcePromptContract` in
 * `in-memory-camera-source-prompt.repository.test.ts`, which runs the same
 * table against this adapter and the in-memory twin. Read that first; it is the
 * real specification, and it is where a behavioural change belongs.
 */

const NOW = new Date('2030-01-01T00:00:00.000Z');
const ADMIN = 100;
const CHAT = 200;
const RECEIPT = '1234567890abcdef';
const SECRET_URL = 'rtsp://operator:hunter2@cam.local/stream1';

function pending(overrides: Partial<NewCameraSourcePrompt> = {}): CameraSourcePrompt {
  return createCameraSourcePrompt({
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
  });
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

/** Column values in the order `insertRow` binds them. */
const ROW_COLUMNS = [
  'user_id', 'chat_id', 'receipt_id', 'prompt_message_id', 'reply_message_id',
  'phase', 'operation', 'camera_id', 'display_name', 'expected_revision',
  'status', 'deletion_failed', 'expires_at', 'retain_until',
] as const;

type RawRow = Record<(typeof ROW_COLUMNS)[number], unknown>;

function rawRow(overrides: Partial<RawRow> = {}): RawRow {
  return {
    user_id: ADMIN,
    chat_id: CHAT,
    receipt_id: RECEIPT,
    prompt_message_id: 90,
    reply_message_id: null,
    phase: 'credential',
    operation: 'create',
    camera_id: null,
    display_name: 'Front Door',
    expected_revision: null,
    status: 'pending',
    deletion_failed: 0,
    expires_at: after(10 * 60_000).getTime(),
    retain_until: null,
    ...overrides,
  };
}

/** Drizzle wraps a raw SQL failure, so the injected reason sits on the cause. */
function reasons(error: unknown): string {
  const chain: string[] = [];
  let current = error;
  while (current instanceof Error) {
    chain.push(current.message);
    current = current.cause;
  }
  return chain.join(' | ');
}

describe('DrizzleCameraSourcePromptRepository', () => {
  let directory: string;
  let sqlite: Database.Database;
  let repository: DrizzleCameraSourcePromptRepository;

  function open(): DrizzleCameraSourcePromptRepository {
    sqlite = new Database(join(directory, 'prompts.db'));
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: './migrations' });
    return new DrizzleCameraSourcePromptRepository(db);
  }

  function insertRow(overrides: Partial<RawRow> = {}): void {
    const row = rawRow(overrides);
    sqlite
      .prepare(
        `INSERT INTO telegram_camera_source_prompts (${ROW_COLUMNS.join(', ')})
         VALUES (${ROW_COLUMNS.map(() => '?').join(', ')})`,
      )
      .run(...ROW_COLUMNS.map((column) => row[column]));
  }

  function rowCount(): number {
    return (sqlite.prepare('SELECT count(*) AS total FROM telegram_camera_source_prompts')
      .get() as { total: number }).total;
  }

  function storedStatus(promptMessageId = 90): string | undefined {
    const row = sqlite
      .prepare('SELECT status FROM telegram_camera_source_prompts WHERE prompt_message_id = ?')
      .get(promptMessageId) as { status: string } | undefined;
    return row?.status;
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'camera-source-prompt-'));
    repository = open();
    sqlite.prepare('INSERT INTO users (telegram_id, name, role) VALUES (?, ?, ?)')
      .run(ADMIN, 'admin', 'admin');
  });

  afterEach(() => {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('keeps a claimed prompt across a process restart', async () => {
    const prompt = pending();
    await repository.createPending(prompt);
    await repository.claimReply({ ...identityOf(prompt), replyMessageId: 91, now: after(1_000) });

    sqlite.close();
    const reopened = open();

    await expect(reopened.listRunning(10)).resolves.toEqual([
      { ...prompt, status: 'running', replyMessageId: 91 },
    ]);
  });

  it('treats a persisted row the prompt model refuses as absent', async () => {
    // A display name that looks like an address passes every SQL check and is
    // still not a value this workflow may act on.
    insertRow({ display_name: SECRET_URL });

    await expect(repository.claimReply({
      userId: ADMIN,
      chatId: CHAT,
      receiptId: RECEIPT,
      promptMessageId: 90,
      replyMessageId: 91,
      now: after(1_000),
    })).resolves.toEqual({ kind: 'stale' });
    await expect(repository.listRunning(10)).resolves.toEqual([]);
  });

  it('sweeps a running row the prompt model refuses, which recovery can never reach', async () => {
    // Address-shaped display name: every SQL check passes, `decode` refuses it.
    // `listRunning` therefore filters it out, so startup recovery never sees the
    // row and never terminalises it. Prune's third arm is the only thing that
    // can reclaim it, and it must still respect the abandonment window.
    insertRow({ status: 'running', reply_message_id: 91, display_name: SECRET_URL });
    const horizon = rawRow().expires_at as number + CAMERA_SOURCE_ABANDONED_TTL_MS;

    await expect(repository.listRunning(10)).resolves.toEqual([]);

    await repository.prune(new Date(horizon - 1));
    expect(rowCount()).toBe(1);

    await repository.prune(new Date(horizon));
    expect(rowCount()).toBe(0);
  });

  it('requires an administrator row before a prompt may exist', async () => {
    await expect(repository.createPending(pending({ userId: 8, chatId: 208 })))
      .rejects.toThrow(/FOREIGN KEY/i);
  });

  it('drops a removed administrator’s prompts with the account', async () => {
    await repository.createPending(pending());

    sqlite.prepare('DELETE FROM users WHERE telegram_id = ?').run(ADMIN);

    expect(sqlite.prepare('SELECT count(*) AS total FROM telegram_camera_source_prompts').get())
      .toEqual({ total: 0 });
  });

  describe('table constraints', () => {
    it.each([
      ['a group chat', { chat_id: -1_001_234_567_890 }],
      ['a channel-shaped chat', { chat_id: -100 }],
      ['an absent chat', { chat_id: 0 }],
      ['a group-shaped administrator', { user_id: -1_001_234_567_890, chat_id: -1_001_234_567_890 }],
      ['a receipt of the wrong length', { receipt_id: '1234567890abcde' }],
      ['a non-positive prompt message', { prompt_message_id: 0 }],
      ['a non-positive reply message', { reply_message_id: 0 }],
      ['an unknown phase', { phase: 'address' }],
      ['an unknown operation', { operation: 'detach' }],
      ['an unknown status', { status: 'claimed' }],
      ['a non-boolean deletion bit', { deletion_failed: 2 }],
      ['a negative expected revision', { expected_revision: -1 }],
      ['a credential prompt with nothing selected', { camera_id: null, display_name: null }],
      ['retention on a live prompt', { retain_until: after(60_000).getTime() }],
      ['a terminal prompt with no retention', { status: 'consumed', retain_until: null }],
      ['a retained name prompt', {
        phase: 'name', status: 'consumed', display_name: null, retain_until: after(60_000).getTime(),
      }],
    ])('refuses %s', (_label, overrides) => {
      expect(() => insertRow(overrides)).toThrow(/CHECK constraint failed/i);
    });

    it('accepts two prompts that differ only by prompt message', () => {
      insertRow({ prompt_message_id: 90 });
      insertRow({ prompt_message_id: 91 });

      expect(sqlite.prepare('SELECT count(*) AS total FROM telegram_camera_source_prompts').get())
        .toEqual({ total: 2 });
      expect(() => insertRow({ prompt_message_id: 91 })).toThrow(/UNIQUE|PRIMARY KEY/i);
    });
  });

  it('rolls the tombstone back when its retention trim cannot commit', async () => {
    for (let index = 0; index <= CAMERA_SOURCE_TOMBSTONES_PER_ADMIN; index += 1) {
      const prompt = pending({ promptMessageId: 1_000 + index });
      await repository.createPending(prompt);
      if (index < CAMERA_SOURCE_TOMBSTONES_PER_ADMIN) {
        await repository.expire({ identity: identityOf(prompt), deletionFailed: false, now: after(index * 1_000) });
      }
    }
    const last = pending({ promptMessageId: 1_000 + CAMERA_SOURCE_TOMBSTONES_PER_ADMIN });
    sqlite.exec(`
      CREATE TRIGGER reject_trim BEFORE DELETE ON telegram_camera_source_prompts
      BEGIN SELECT RAISE(ABORT, 'injected trim failure'); END;
    `);

    const failure = await repository
      .expire({ identity: identityOf(last), deletionFailed: false, now: after(1_000_000) })
      .then(() => null, (error: unknown) => error);

    expect(reasons(failure)).toMatch(/injected trim failure/);

    // The update and the trim share one transaction, so neither survives.
    expect(storedStatus(last.promptMessageId)).toBe('pending');
    expect(sqlite.prepare(
      'SELECT count(*) AS total FROM telegram_camera_source_prompts WHERE retain_until IS NOT NULL',
    ).get()).toEqual({ total: CAMERA_SOURCE_TOMBSTONES_PER_ADMIN });
  });

  it('rolls the claim back when the transition cannot commit', async () => {
    const prompt = pending();
    await repository.createPending(prompt);
    sqlite.exec(`
      CREATE TRIGGER reject_claim BEFORE UPDATE ON telegram_camera_source_prompts
      WHEN new.status = 'running'
      BEGIN SELECT RAISE(ABORT, 'injected claim failure'); END;
    `);

    await expect(repository.claimReply({ ...identityOf(prompt), replyMessageId: 91, now: after(1_000) }))
      .rejects.toThrow(/injected claim failure/);

    expect(storedStatus()).toBe('pending');
    expect(sqlite.prepare(
      'SELECT reply_message_id AS replyMessageId FROM telegram_camera_source_prompts',
    ).get()).toEqual({ replyMessageId: null });
  });
});

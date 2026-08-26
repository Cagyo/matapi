import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { AppDatabase, DB } from '../../database/database.module';
import { telegramCameraSourcePrompts } from '../../database/schema';
import type {
  CameraSourcePromptClaim,
  CameraSourcePromptRepositoryPort,
} from '../application/ports/camera-source-prompt-repository.port';
import {
  CAMERA_SOURCE_ABANDONED_TTL_MS,
  CAMERA_SOURCE_TOMBSTONE_TTL_MS,
  CAMERA_SOURCE_TOMBSTONES_PER_ADMIN,
  assertCameraSourcePrompt,
  assertCameraSourcePromptOutcome,
  assertCameraSourcePromptReply,
  isCameraSourcePrompt,
  isCameraSourcePromptLive,
  isTerminalCameraSourcePromptStatus,
  type CameraSourcePrompt,
  type CameraSourcePromptIdentity,
  type CameraSourcePromptStatus,
} from '../domain/camera-source-prompt';

type PromptRow = typeof telegramCameraSourcePrompts.$inferSelect;
type PromptWriter = Pick<AppDatabase, 'insert' | 'select' | 'update' | 'delete' | 'run'>;

/** better-sqlite3 reports the composite primary key as a PRIMARYKEY constraint. */
function isPrimaryKeyViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

function identityKey(identity: CameraSourcePromptIdentity) {
  return and(
    eq(telegramCameraSourcePrompts.userId, identity.userId),
    eq(telegramCameraSourcePrompts.chatId, identity.chatId),
    eq(telegramCameraSourcePrompts.receiptId, identity.receiptId),
    eq(telegramCameraSourcePrompts.promptMessageId, identity.promptMessageId),
  );
}

/** A row the prompt model refuses is treated as absent, never as half-valid state. */
function decode(row: PromptRow): CameraSourcePrompt | null {
  const prompt: unknown = {
    userId: row.userId,
    chatId: row.chatId,
    receiptId: row.receiptId,
    promptMessageId: row.promptMessageId,
    replyMessageId: row.replyMessageId,
    phase: row.phase,
    operation: row.operation,
    cameraId: row.cameraId,
    displayName: row.displayName,
    expectedRevision: row.expectedRevision,
    status: row.status,
    deletionFailed: row.deletionFailed,
    expiresAt: row.expiresAt,
    retainUntil: row.retainUntil,
  };
  return isCameraSourcePrompt(prompt) ? prompt : null;
}

/**
 * Durable prompt authority. Every state change runs inside one synchronous
 * better-sqlite3 immediate transaction, so the exact-reply claim is a single
 * compare-and-set that a concurrent update cannot interleave with.
 *
 * The table has no column that could hold a URL, a credential, or a diagnostic,
 * and `assertCameraSourcePrompt` guards both the write and the read boundary —
 * a value carrying an unpublished field never reaches SQLite.
 */
@Injectable()
export class DrizzleCameraSourcePromptRepository implements CameraSourcePromptRepositoryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async createPending(prompt: CameraSourcePrompt): Promise<void> {
    const pending = assertCameraSourcePrompt(prompt);
    if (
      pending.status !== 'pending' ||
      pending.replyMessageId !== null ||
      pending.deletionFailed ||
      pending.retainUntil !== null
    ) {
      throw new RangeError('camera source prompt is not newly minted');
    }
    this.immediate((tx) => {
      try {
        tx.insert(telegramCameraSourcePrompts).values(pending).run();
      } catch (error) {
        // Only the composite primary key is translated. A CHECK or foreign-key
        // failure means something else is wrong and must surface as itself.
        if (isPrimaryKeyViolation(error)) {
          throw new RangeError('camera source prompt already exists');
        }
        throw error;
      }
    });
  }

  async claimReply(input: {
    userId: number;
    chatId: number;
    receiptId: string;
    promptMessageId: number;
    replyMessageId: number;
    now: Date;
  }): Promise<CameraSourcePromptClaim> {
    const identity = assertCameraSourcePromptReply(input);
    return this.immediate((tx) => {
      const stored = this.load(tx, identity);
      if (!stored) return { kind: 'stale' };
      if (!isCameraSourcePromptLive(stored, input.now)) return { kind: 'late', prompt: stored };

      const claimed = assertCameraSourcePrompt({
        ...stored,
        status: 'running',
        replyMessageId: input.replyMessageId,
      });
      const result = tx
        .update(telegramCameraSourcePrompts)
        .set({ status: claimed.status, replyMessageId: claimed.replyMessageId })
        .where(and(identityKey(identity), eq(telegramCameraSourcePrompts.status, 'pending')))
        .run();
      // Losing the compare-and-set cannot mean "no such prompt" — the row was
      // just read. Report it as late so the caller still deletes the credential
      // message rather than walking away from it.
      return result.changes === 1 ? { kind: 'claimed', prompt: claimed } : { kind: 'late', prompt: stored };
    });
  }

  async consume(input: {
    identity: CameraSourcePromptIdentity;
    deletionFailed: boolean;
    now: Date;
  }): Promise<void> {
    this.finish(input, 'consumed');
  }

  async expire(input: {
    identity: CameraSourcePromptIdentity;
    deletionFailed: boolean;
    now: Date;
  }): Promise<void> {
    this.finish(input, 'expired');
  }

  async listRunning(limit: number): Promise<readonly CameraSourcePrompt[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError('camera source prompt listing limit is malformed');
    }
    const rows = this.db
      .select()
      .from(telegramCameraSourcePrompts)
      .where(eq(telegramCameraSourcePrompts.status, 'running'))
      .orderBy(
        asc(telegramCameraSourcePrompts.expiresAt),
        asc(telegramCameraSourcePrompts.userId),
        asc(telegramCameraSourcePrompts.receiptId),
        asc(telegramCameraSourcePrompts.promptMessageId),
      )
      .limit(limit)
      .all();
    return rows.map(decode).filter((prompt): prompt is CameraSourcePrompt => prompt !== null);
  }

  async prune(now: Date): Promise<void> {
    if (Number.isNaN(now.getTime())) throw new RangeError('camera source prompt prune instant is malformed');
    // Every arm carries a predicate, and no status is exempt from all of them:
    // a row that never reaches a terminal state is still swept once abandoned,
    // so nothing here is immortal.
    //
    // The two abandonment arms SEARCH `idx_..._live` on (status, expires_at).
    // The tombstone arm is a SCAN — `idx_..._retention` leads on `user_id`,
    // which this predicate does not constrain — and that is deliberate: the
    // table is capped per administrator and stays small, so an index existing
    // only to serve prune would cost more on every write than it saves here.
    const abandonedBefore = new Date(now.getTime() - CAMERA_SOURCE_ABANDONED_TTL_MS);
    this.immediate((tx) => {
      tx.delete(telegramCameraSourcePrompts)
        .where(and(isNotNull(telegramCameraSourcePrompts.retainUntil), lte(telegramCameraSourcePrompts.retainUntil, now)))
        .run();
      // Never answered.
      tx.delete(telegramCameraSourcePrompts)
        .where(and(
          isNull(telegramCameraSourcePrompts.retainUntil),
          eq(telegramCameraSourcePrompts.status, 'pending'),
          lte(telegramCameraSourcePrompts.expiresAt, abandonedBefore),
        ))
        .run();
      // Claimed, then interrupted. Startup recovery normally terminalises these
      // first; this arm is the backstop for rows it cannot reach — a name prompt
      // it does not act on, or one whose stored row no longer decodes — and by
      // then Telegram will not delete the message anyway.
      tx.delete(telegramCameraSourcePrompts)
        .where(and(
          isNull(telegramCameraSourcePrompts.retainUntil),
          eq(telegramCameraSourcePrompts.status, 'running'),
          lte(telegramCameraSourcePrompts.expiresAt, abandonedBefore),
        ))
        .run();
    });
  }

  private finish(
    input: { identity: CameraSourcePromptIdentity; deletionFailed: boolean; now: Date },
    outcome: Extract<CameraSourcePromptStatus, 'consumed' | 'expired'>,
  ): void {
    const identity = assertCameraSourcePromptOutcome(input);
    this.immediate((tx) => {
      const stored = this.load(tx, identity);
      if (!stored) return;
      if (stored.phase === 'name') {
        tx.delete(telegramCameraSourcePrompts).where(identityKey(identity)).run();
        return;
      }
      const settled = isTerminalCameraSourcePromptStatus(stored.status) && stored.retainUntil !== null;
      // The first terminal transition owns both the outcome and the retention
      // deadline: a late reply reaching a consumed prompt must not restate it as
      // expired, nor extend the window it is already serving out.
      const status = settled ? stored.status : outcome;
      const retainUntil = settled
        ? stored.retainUntil
        : new Date(input.now.getTime() + CAMERA_SOURCE_TOMBSTONE_TTL_MS);
      // Sticky: a deletion that failed once stays recorded. `replyMessageId`
      // still names a message that may be sitting in the chat, so clearing the
      // bit on a later clean pass would erase the only evidence of it.
      const deletionFailed = stored.deletionFailed || input.deletionFailed;
      const tombstone = assertCameraSourcePrompt({ ...stored, status, deletionFailed, retainUntil });
      tx.update(telegramCameraSourcePrompts)
        .set({ status: tombstone.status, deletionFailed: tombstone.deletionFailed, retainUntil: tombstone.retainUntil })
        .where(identityKey(identity))
        .run();
      this.trimTombstones(tx, identity.userId);
    });
  }

  /** Keeps the newest tombstones per administrator; bounded by the retention index. */
  private trimTombstones(tx: PromptWriter, userId: number): void {
    tx.run(sql`
      delete from ${telegramCameraSourcePrompts}
      where rowid in (
        select rowid from ${telegramCameraSourcePrompts}
        where ${telegramCameraSourcePrompts.userId} = ${userId}
          and ${telegramCameraSourcePrompts.retainUntil} is not null
        order by ${telegramCameraSourcePrompts.retainUntil} desc,
                 ${telegramCameraSourcePrompts.promptMessageId} desc,
                 ${telegramCameraSourcePrompts.receiptId} desc
        limit -1 offset ${CAMERA_SOURCE_TOMBSTONES_PER_ADMIN}
      )
    `);
  }

  private load(tx: PromptWriter, identity: CameraSourcePromptIdentity): CameraSourcePrompt | null {
    const row = tx.select().from(telegramCameraSourcePrompts).where(identityKey(identity)).get();
    return row ? decode(row) : null;
  }

  private immediate<T>(operation: (tx: PromptWriter) => T): T {
    return this.db.transaction((tx) => operation(tx), { behavior: 'immediate' });
  }
}

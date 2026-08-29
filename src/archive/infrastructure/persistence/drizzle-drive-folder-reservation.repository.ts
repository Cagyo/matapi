import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { AppDatabase, DB } from '../../../database/database.module';
import { driveMotionFolderReservations } from '../../../database/schema';
import type {
  DriveFolderReservationRepositoryPort,
  ReserveDriveFolder,
} from '../../application/ports/drive-folder-reservation-repository.port';
import {
  DriveFolderReservation,
  type DriveFolderLevel,
  type DriveFolderReservationState,
} from '../../domain/drive-folder-reservation.entity';

type ReservationRow = typeof driveMotionFolderReservations.$inferSelect;
type Writer = Pick<AppDatabase, 'insert' | 'select' | 'update'>;
type CurrentResult =
  | { kind: 'stored'; reservation: DriveFolderReservation }
  | { kind: 'lost'; current: DriveFolderReservation | null };

const MINIMUM_REVALIDATION_SLOT_MS = 15 * 60_000;

/** SQLite implementation of durable folder-head reservation and replacement CAS. */
@Injectable()
export class DrizzleDriveFolderReservationRepository implements DriveFolderReservationRepositoryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async loadCurrent(generationId: string, normalizedPath: string): Promise<DriveFolderReservation | null> {
    const row = this.current(this.db, generationId, normalizedPath);
    return row ? toReservation(row) : null;
  }

  async claimNextBlockedRevalidation(input: {
    generationId: string;
    nowMs: number;
    claimUntilMs: number;
  }): Promise<DriveFolderReservation | null> {
    return this.immediate((tx) => {
      const existingClaim = tx.select({ id: driveMotionFolderReservations.id })
        .from(driveMotionFolderReservations).where(and(
          eq(driveMotionFolderReservations.generationId, input.generationId),
          eq(driveMotionFolderReservations.currentSlot, 1),
          inArray(driveMotionFolderReservations.state, ['detached', 'conflict']),
          gt(driveMotionFolderReservations.nextRevalidationAt, input.nowMs),
          sql`${driveMotionFolderReservations.nextRevalidationAt}
            - ${driveMotionFolderReservations.updatedAt}
            < ${MINIMUM_REVALIDATION_SLOT_MS}`,
        )).get();
      if (existingClaim !== undefined) return null;
      const row = tx.select().from(driveMotionFolderReservations).where(and(
        dueBlockedHead(input.generationId, input.nowMs),
      )).orderBy(
        asc(driveMotionFolderReservations.nextRevalidationAt),
        asc(driveMotionFolderReservations.normalizedPath),
        asc(driveMotionFolderReservations.id),
      ).limit(1).get();
      if (row === undefined) return null;
      const claimed = DriveFolderReservation.restore({
        ...toReservation(row),
        revision: row.revision + 1,
        nextRevalidationAtMs: input.claimUntilMs,
        updatedAtMs: input.nowMs,
      });
      const result = tx.update(driveMotionFolderReservations).set({
        revision: claimed.revision,
        nextRevalidationAt: claimed.nextRevalidationAtMs,
        updatedAt: claimed.updatedAtMs,
      }).where(and(
        eq(driveMotionFolderReservations.id, row.id),
        eq(driveMotionFolderReservations.generationId, input.generationId),
        eq(driveMotionFolderReservations.currentSlot, 1),
        eq(driveMotionFolderReservations.state, row.state),
        eq(driveMotionFolderReservations.revision, row.revision),
        inArray(driveMotionFolderReservations.state, ['detached', 'conflict']),
        lte(driveMotionFolderReservations.nextRevalidationAt, input.nowMs),
      )).run();
      return result.changes === 1 ? claimed : null;
    });
  }

  async requestNextBlockedRevalidation(input: {
    generationId: string;
    nowMs: number;
  }): Promise<DriveFolderReservation | null> {
    return this.immediate((tx) => {
      const row = tx.select().from(driveMotionFolderReservations).where(and(
        eq(driveMotionFolderReservations.generationId, input.generationId),
        eq(driveMotionFolderReservations.currentSlot, 1),
        inArray(driveMotionFolderReservations.state, ['detached', 'conflict']),
      )).orderBy(
        asc(driveMotionFolderReservations.nextRevalidationAt),
        asc(driveMotionFolderReservations.normalizedPath),
        asc(driveMotionFolderReservations.id),
      ).limit(1).get();
      if (row === undefined) return null;
      const requested = DriveFolderReservation.restore({
        ...toReservation(row),
        revision: row.revision + 1,
        nextRevalidationAtMs: input.nowMs,
        updatedAtMs: input.nowMs,
      });
      const result = tx.update(driveMotionFolderReservations).set({
        revision: requested.revision,
        nextRevalidationAt: requested.nextRevalidationAtMs,
        updatedAt: requested.updatedAtMs,
      }).where(and(
        eq(driveMotionFolderReservations.id, row.id),
        eq(driveMotionFolderReservations.generationId, input.generationId),
        eq(driveMotionFolderReservations.currentSlot, 1),
        eq(driveMotionFolderReservations.state, row.state),
        eq(driveMotionFolderReservations.revision, row.revision),
        inArray(driveMotionFolderReservations.state, ['detached', 'conflict']),
      )).run();
      return result.changes === 1 ? requested : null;
    });
  }

  async restoreDetached(
    id: string,
    expectedRevision: number,
    nowMs: number,
  ): Promise<DriveFolderReservation | null> {
    return this.immediate((tx) => {
      const row = tx.select().from(driveMotionFolderReservations).where(and(
        eq(driveMotionFolderReservations.id, id),
        eq(driveMotionFolderReservations.currentSlot, 1),
        eq(driveMotionFolderReservations.state, 'detached'),
        eq(driveMotionFolderReservations.revision, expectedRevision),
      )).get();
      if (row === undefined) return null;
      const restored = toReservation(row).restoreAfterRevalidation(nowMs);
      const result = tx.update(driveMotionFolderReservations).set({
        state: restored.state,
        revision: restored.revision,
        errorCode: restored.errorCode,
        revalidationFailureStreak: restored.revalidationFailureStreak,
        nextRevalidationAt: restored.nextRevalidationAtMs,
        updatedAt: restored.updatedAtMs,
        verifiedAt: restored.verifiedAtMs,
      }).where(and(
        eq(driveMotionFolderReservations.id, id),
        eq(driveMotionFolderReservations.currentSlot, 1),
        eq(driveMotionFolderReservations.state, 'detached'),
        eq(driveMotionFolderReservations.revision, expectedRevision),
      )).run();
      return result.changes === 1 ? restored : null;
    });
  }

  async adoptConflictCandidate(input: {
    expected: { id: string; revision: number };
    replacement: ReserveDriveFolder;
    nowMs: number;
  }): Promise<CurrentResult> {
    try {
      return this.immediate((tx) => {
        const expectedRow = tx.select().from(driveMotionFolderReservations)
          .where(eq(driveMotionFolderReservations.id, input.expected.id)).get();
        const current = expectedRow === undefined
          ? undefined
          : this.current(tx, expectedRow.generationId, expectedRow.normalizedPath);
        if (expectedRow === undefined
          || current?.id !== expectedRow.id
          || expectedRow.currentSlot !== 1
          || expectedRow.state !== 'conflict'
          || expectedRow.revision !== input.expected.revision
          || !sameReservationIdentity(toReservation(expectedRow), input.replacement)
          || this.hasReservationIdentity(tx, input.replacement)) {
          return lost(current);
        }

        const cleared = tx.update(driveMotionFolderReservations).set({
          currentSlot: null,
          revision: expectedRow.revision + 1,
          updatedAt: input.nowMs,
        }).where(and(
          eq(driveMotionFolderReservations.id, input.expected.id),
          eq(driveMotionFolderReservations.currentSlot, 1),
          eq(driveMotionFolderReservations.state, 'conflict'),
          eq(driveMotionFolderReservations.revision, input.expected.revision),
        )).run();
        if (cleared.changes !== 1) {
          return lost(this.current(tx, expectedRow.generationId, expectedRow.normalizedPath));
        }

        const replacement = DriveFolderReservation.reserve({
          ...input.replacement,
          nowMs: input.nowMs,
        }).verify(input.nowMs);
        tx.insert(driveMotionFolderReservations).values(reservationRow(replacement)).run();
        return { kind: 'stored', reservation: replacement };
      });
    } catch (error) {
      if (isLostConstraint(error)) return this.lostExpected(input.expected.id);
      throw error;
    }
  }

  async rescheduleBlockedRevalidation(input: {
    id: string;
    expectedRevision: number;
    errorCode: string;
    nowMs: number;
    nextRevalidationAtMs: number;
  }): Promise<DriveFolderReservation | null> {
    return this.immediate((tx) => {
      const row = tx.select().from(driveMotionFolderReservations).where(and(
        eq(driveMotionFolderReservations.id, input.id),
        eq(driveMotionFolderReservations.currentSlot, 1),
        inArray(driveMotionFolderReservations.state, ['detached', 'conflict']),
        eq(driveMotionFolderReservations.revision, input.expectedRevision),
      )).get();
      if (row === undefined) return null;
      const rescheduled = toReservation(row).rescheduleRevalidation(
        input.errorCode,
        input.nowMs,
        input.nextRevalidationAtMs,
      );
      const result = tx.update(driveMotionFolderReservations).set({
        revision: rescheduled.revision,
        errorCode: rescheduled.errorCode,
        revalidationFailureStreak: rescheduled.revalidationFailureStreak,
        nextRevalidationAt: rescheduled.nextRevalidationAtMs,
        updatedAt: rescheduled.updatedAtMs,
      }).where(and(
        eq(driveMotionFolderReservations.id, input.id),
        eq(driveMotionFolderReservations.currentSlot, 1),
        eq(driveMotionFolderReservations.state, row.state),
        inArray(driveMotionFolderReservations.state, ['detached', 'conflict']),
        eq(driveMotionFolderReservations.revision, input.expectedRevision),
      )).run();
      return result.changes === 1 ? rescheduled : null;
    });
  }

  async compareAndSetCurrent(input: {
    expected: { id: string; revision: number } | null;
    replacement: ReserveDriveFolder;
    nowMs: number;
  }): Promise<CurrentResult> {
    try {
      return this.immediate((tx) => {
        const current = this.current(tx, input.replacement.generationId, input.replacement.normalizedPath);
        if (!matches(current, input.expected)) return lost(current);

        if (current) {
          const released = tx.update(driveMotionFolderReservations).set({ currentSlot: null })
            .where(and(
              eq(driveMotionFolderReservations.id, input.expected!.id),
              eq(driveMotionFolderReservations.revision, input.expected!.revision),
              eq(driveMotionFolderReservations.currentSlot, 1),
            )).run();
          if (released.changes !== 1) return lost(this.current(tx, input.replacement.generationId, input.replacement.normalizedPath));
        }

        const replacement = DriveFolderReservation.reserve({ ...input.replacement, nowMs: input.nowMs });
        tx.insert(driveMotionFolderReservations).values(reservationRow(replacement)).run();
        return { kind: 'stored', reservation: replacement };
      });
    } catch (error) {
      if (isLostConstraint(error)) return this.lostCurrent(input.replacement.generationId, input.replacement.normalizedPath);
      throw error;
    }
  }

  async appendMissingIdentity(input: {
    reservation: ReserveDriveFolder;
    nowMs: number;
  }): Promise<'stored' | 'exists'> {
    return this.immediate((tx) => {
      const existing = tx.select({ id: driveMotionFolderReservations.id })
        .from(driveMotionFolderReservations)
        .where(eq(driveMotionFolderReservations.folderId, input.reservation.folderId))
        .get();
      if (existing !== undefined) return 'exists';
      tx.insert(driveMotionFolderReservations)
        .values(reservationRow(missingIdentity(input.reservation, input.nowMs)))
        .run();
      return 'stored';
    });
  }

  async markVerified(id: string, expectedRevision: number, nowMs: number): Promise<DriveFolderReservation | null> {
    return this.immediate((tx) => {
      const row = tx.select().from(driveMotionFolderReservations)
        .where(and(eq(driveMotionFolderReservations.id, id), eq(driveMotionFolderReservations.revision, expectedRevision))).get();
      if (!row) return null;
      const verified = toReservation(row).verify(nowMs);
      const result = tx.update(driveMotionFolderReservations).set({
        state: verified.state,
        revision: verified.revision,
        errorCode: verified.errorCode,
        revalidationFailureStreak: verified.revalidationFailureStreak,
        nextRevalidationAt: verified.nextRevalidationAtMs,
        updatedAt: verified.updatedAtMs,
        verifiedAt: verified.verifiedAtMs,
      }).where(and(eq(driveMotionFolderReservations.id, id), eq(driveMotionFolderReservations.revision, expectedRevision))).run();
      return result.changes === 1 ? verified : null;
    });
  }

  async markBlocked(
    id: string,
    expectedRevision: number,
    state: 'detached' | 'conflict',
    errorCode: string,
    nowMs: number,
    nextRevalidationAtMs: number | null = null,
  ): Promise<DriveFolderReservation | null> {
    return this.immediate((tx) => {
      const row = tx.select().from(driveMotionFolderReservations)
        .where(and(eq(driveMotionFolderReservations.id, id), eq(driveMotionFolderReservations.revision, expectedRevision))).get();
      if (!row) return null;
      const blocked = toReservation(row).block(state, errorCode, nowMs, nextRevalidationAtMs);
      const result = tx.update(driveMotionFolderReservations).set({
        state: blocked.state,
        revision: blocked.revision,
        errorCode: blocked.errorCode,
        revalidationFailureStreak: blocked.revalidationFailureStreak,
        nextRevalidationAt: blocked.nextRevalidationAtMs,
        updatedAt: blocked.updatedAtMs,
        verifiedAt: blocked.verifiedAtMs,
      }).where(and(eq(driveMotionFolderReservations.id, id), eq(driveMotionFolderReservations.revision, expectedRevision))).run();
      return result.changes === 1 ? blocked : null;
    });
  }

  async replaceMissing(input: {
    expected: { id: string; revision: number; folderId: string };
    replacement: ReserveDriveFolder;
    nowMs: number;
  }): Promise<CurrentResult> {
    try {
      return this.immediate((tx) => {
        const current = this.current(tx, input.replacement.generationId, input.replacement.normalizedPath);
        if (current?.id !== input.expected.id || current.revision !== input.expected.revision
          || current.folderId !== input.expected.folderId) return lost(current);

        const missing = toReservation(current);
        const cleared = tx.update(driveMotionFolderReservations).set({
          state: 'missing', currentSlot: null, revision: missing.revision + 1, updatedAt: input.nowMs,
        }).where(and(
          eq(driveMotionFolderReservations.id, input.expected.id),
          eq(driveMotionFolderReservations.revision, input.expected.revision),
          eq(driveMotionFolderReservations.folderId, input.expected.folderId),
          eq(driveMotionFolderReservations.currentSlot, 1),
        )).run();
        if (cleared.changes !== 1) return lost(this.current(tx, input.replacement.generationId, input.replacement.normalizedPath));

        tx.update(driveMotionFolderReservations).set({
          state: 'superseded', currentSlot: null,
          revision: sql`${driveMotionFolderReservations.revision} + 1`, updatedAt: input.nowMs,
        }).where(and(
          eq(driveMotionFolderReservations.generationId, input.replacement.generationId),
          eq(driveMotionFolderReservations.currentSlot, 1),
          startsWithPath(driveMotionFolderReservations.normalizedPath, `${input.replacement.normalizedPath}/`),
        )).run();

        const replacement = DriveFolderReservation.reserve({ ...input.replacement, nowMs: input.nowMs });
        tx.insert(driveMotionFolderReservations).values(reservationRow(replacement)).run();
        return { kind: 'stored', reservation: replacement };
      });
    } catch (error) {
      if (isLostConstraint(error)) return this.lostCurrent(input.replacement.generationId, input.replacement.normalizedPath);
      throw error;
    }
  }

  async countUnhealthy(generationId: string): Promise<number> {
    const row = this.db.select({ count: count() }).from(driveMotionFolderReservations).where(and(
      eq(driveMotionFolderReservations.generationId, generationId),
      eq(driveMotionFolderReservations.currentSlot, 1),
      inArray(driveMotionFolderReservations.state, ['missing', 'detached', 'conflict']),
    )).get();
    return row?.count ?? 0;
  }

  private current(db: Pick<AppDatabase, 'select'>, generationId: string, normalizedPath: string): ReservationRow | undefined {
    return db.select().from(driveMotionFolderReservations).where(and(
      eq(driveMotionFolderReservations.generationId, generationId),
      eq(driveMotionFolderReservations.normalizedPath, normalizedPath),
      eq(driveMotionFolderReservations.currentSlot, 1),
    )).get();
  }

  private async lostCurrent(generationId: string, normalizedPath: string): Promise<CurrentResult> {
    return { kind: 'lost', current: await this.loadCurrent(generationId, normalizedPath) };
  }

  private async lostExpected(id: string): Promise<CurrentResult> {
    const expected = this.db.select().from(driveMotionFolderReservations)
      .where(eq(driveMotionFolderReservations.id, id)).get();
    if (expected === undefined) return { kind: 'lost', current: null };
    return this.lostCurrent(expected.generationId, expected.normalizedPath);
  }

  private hasReservationIdentity(db: Writer, replacement: ReserveDriveFolder): boolean {
    return db.select({ id: driveMotionFolderReservations.id })
      .from(driveMotionFolderReservations)
      .where(sql`${driveMotionFolderReservations.id} = ${replacement.id}
        or ${driveMotionFolderReservations.folderId} = ${replacement.folderId}`)
      .get() !== undefined;
  }

  private immediate<T>(operation: (tx: Writer) => T): T {
    return this.db.transaction((tx) => operation(tx), { behavior: 'immediate' });
  }
}

function reservationRow(reservation: DriveFolderReservation) {
  return {
    id: reservation.id,
    installationId: reservation.installationId,
    generationId: reservation.generationId,
    normalizedPath: reservation.normalizedPath,
    level: reservation.level,
    segmentName: reservation.segmentName,
    folderId: reservation.folderId,
    parentFolderId: reservation.parentFolderId,
    state: reservation.state,
    currentSlot: reservation.currentSlot,
    revision: reservation.revision,
    errorCode: reservation.errorCode,
    revalidationFailureStreak: reservation.revalidationFailureStreak,
    nextRevalidationAt: reservation.nextRevalidationAtMs,
    createdAt: reservation.createdAtMs,
    updatedAt: reservation.updatedAtMs,
    verifiedAt: reservation.verifiedAtMs,
  };
}

function missingIdentity(reservation: ReserveDriveFolder, nowMs: number): DriveFolderReservation {
  return DriveFolderReservation.restore({
    ...reservation,
    state: 'missing',
    currentSlot: null,
    revision: 0,
    errorCode: null,
    revalidationFailureStreak: 0,
    nextRevalidationAtMs: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    verifiedAtMs: null,
  });
}

function toReservation(row: ReservationRow): DriveFolderReservation {
  return DriveFolderReservation.restore({
    id: row.id,
    installationId: row.installationId,
    generationId: row.generationId,
    normalizedPath: row.normalizedPath,
    level: row.level as DriveFolderLevel,
    segmentName: row.segmentName,
    folderId: row.folderId,
    parentFolderId: row.parentFolderId,
    state: row.state as DriveFolderReservationState,
    currentSlot: row.currentSlot as 1 | null,
    revision: row.revision,
    errorCode: row.errorCode,
    revalidationFailureStreak: row.revalidationFailureStreak,
    nextRevalidationAtMs: row.nextRevalidationAt,
    createdAtMs: row.createdAt,
    updatedAtMs: row.updatedAt,
    verifiedAtMs: row.verifiedAt,
  });
}

function matches(row: ReservationRow | undefined, expected: { id: string; revision: number } | null): boolean {
  return expected === null ? row === undefined : row?.id === expected.id && row.revision === expected.revision;
}

function dueBlockedHead(generationId: string, nowMs: number) {
  return and(
    eq(driveMotionFolderReservations.generationId, generationId),
    eq(driveMotionFolderReservations.currentSlot, 1),
    inArray(driveMotionFolderReservations.state, ['detached', 'conflict']),
    lte(driveMotionFolderReservations.nextRevalidationAt, nowMs),
  );
}

function sameReservationIdentity(
  current: DriveFolderReservation,
  replacement: ReserveDriveFolder,
): boolean {
  return current.installationId === replacement.installationId
    && current.generationId === replacement.generationId
    && current.normalizedPath === replacement.normalizedPath
    && current.level === replacement.level
    && current.segmentName === replacement.segmentName
    && current.parentFolderId === replacement.parentFolderId;
}

function lost(row: ReservationRow | undefined): CurrentResult {
  return { kind: 'lost', current: row ? toReservation(row) : null };
}

function startsWithPath(column: typeof driveMotionFolderReservations.normalizedPath, prefix: string) {
  return sql`substr(${column}, 1, ${prefix.length}) = ${prefix}`;
}

function isLostConstraint(error: unknown): boolean {
  return !!error && typeof error === 'object' && [
    'SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY',
  ].includes((error as { code?: unknown }).code as string);
}

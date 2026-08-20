import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
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

/** SQLite implementation of durable folder-head reservation and replacement CAS. */
@Injectable()
export class DrizzleDriveFolderReservationRepository implements DriveFolderReservationRepositoryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async loadCurrent(generationId: string, normalizedPath: string): Promise<DriveFolderReservation | null> {
    const row = this.current(this.db, generationId, normalizedPath);
    return row ? toReservation(row) : null;
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
  ): Promise<DriveFolderReservation | null> {
    return this.immediate((tx) => {
      const row = tx.select().from(driveMotionFolderReservations)
        .where(and(eq(driveMotionFolderReservations.id, id), eq(driveMotionFolderReservations.revision, expectedRevision))).get();
      if (!row) return null;
      const blocked = toReservation(row).block(state, errorCode, nowMs);
      const result = tx.update(driveMotionFolderReservations).set({
        state: blocked.state,
        revision: blocked.revision,
        errorCode: blocked.errorCode,
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
    createdAt: reservation.createdAtMs,
    updatedAt: reservation.updatedAtMs,
    verifiedAt: reservation.verifiedAtMs,
  };
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
    createdAtMs: row.createdAt,
    updatedAtMs: row.updatedAt,
    verifiedAtMs: row.verifiedAt,
  });
}

function matches(row: ReservationRow | undefined, expected: { id: string; revision: number } | null): boolean {
  return expected === null ? row === undefined : row?.id === expected.id && row.revision === expected.revision;
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

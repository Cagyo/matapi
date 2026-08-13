import type {
  DriveFolderReservationRepositoryPort,
  ReserveDriveFolder,
} from '../../application/ports/drive-folder-reservation-repository.port';
import {
  DriveFolderReservation,
  type DriveFolderReservationSnapshot,
} from '../../domain/drive-folder-reservation.entity';

/** Deterministic in-memory parity adapter for folder-reservation use cases. */
export class InMemoryDriveFolderReservationRepository implements DriveFolderReservationRepositoryPort {
  private readonly reservations = new Map<string, DriveFolderReservation>();
  private readonly currentHeads = new Map<string, string>();

  async loadCurrent(generationId: string, normalizedPath: string): Promise<DriveFolderReservation | null> {
    return this.cloneNullable(this.currentFor(generationId, normalizedPath));
  }

  async compareAndSetCurrent(input: {
    expected: { id: string; revision: number } | null;
    replacement: ReserveDriveFolder;
    nowMs: number;
  }): Promise<{ kind: 'stored'; reservation: DriveFolderReservation } | { kind: 'lost'; current: DriveFolderReservation | null }> {
    const current = this.currentFor(input.replacement.generationId, input.replacement.normalizedPath);
    if (!matches(current, input.expected) || this.reservations.has(input.replacement.id)) {
      return { kind: 'lost', current: this.cloneNullable(current) };
    }
    const reservation = DriveFolderReservation.reserve({ ...input.replacement, nowMs: input.nowMs });
    this.reservations.set(reservation.id, reservation);
    this.currentHeads.set(keyFor(reservation.generationId, reservation.normalizedPath), reservation.id);
    return { kind: 'stored', reservation: this.clone(reservation) };
  }

  async markVerified(id: string, expectedRevision: number, nowMs: number): Promise<DriveFolderReservation | null> {
    const current = this.reservations.get(id);
    if (!current || current.revision !== expectedRevision) return null;
    const verified = current.verify(nowMs);
    this.reservations.set(id, verified);
    return this.clone(verified);
  }

  async markBlocked(id: string, expectedRevision: number, state: 'detached' | 'conflict', errorCode: string, nowMs: number): Promise<DriveFolderReservation | null> {
    const current = this.reservations.get(id);
    if (!current || current.revision !== expectedRevision) return null;
    const blocked = current.block(state, errorCode, nowMs);
    this.reservations.set(id, blocked);
    return this.clone(blocked);
  }

  async replaceMissing(input: {
    expected: { id: string; revision: number; folderId: string };
    replacement: ReserveDriveFolder;
    nowMs: number;
  }): Promise<{ kind: 'stored'; reservation: DriveFolderReservation } | { kind: 'lost'; current: DriveFolderReservation | null }> {
    const current = this.currentFor(input.replacement.generationId, input.replacement.normalizedPath);
    if (!current || current.id !== input.expected.id || current.revision !== input.expected.revision || current.folderId !== input.expected.folderId || this.reservations.has(input.replacement.id)) {
      return { kind: 'lost', current: this.cloneNullable(current) };
    }

    const replacement = DriveFolderReservation.reserve({ ...input.replacement, nowMs: input.nowMs });
    const descendants = [...this.currentHeads.entries()]
      .filter(([key]) => key.startsWith(`${input.replacement.generationId}\0${input.replacement.normalizedPath}/`))
      .map(([, id]) => this.reservations.get(id))
      .filter((reservation): reservation is DriveFolderReservation => reservation !== undefined);
    const missing = restoreWithState(current, 'missing', input.nowMs);
    const superseded = descendants.map((reservation) => restoreWithState(reservation, 'superseded', input.nowMs));

    this.reservations.set(missing.id, missing);
    for (const reservation of superseded) {
      this.reservations.set(reservation.id, reservation);
      this.currentHeads.delete(keyFor(reservation.generationId, reservation.normalizedPath));
    }
    this.currentHeads.delete(keyFor(current.generationId, current.normalizedPath));
    this.reservations.set(replacement.id, replacement);
    this.currentHeads.set(keyFor(replacement.generationId, replacement.normalizedPath), replacement.id);
    return { kind: 'stored', reservation: this.clone(replacement) };
  }

  async countUnhealthy(generationId: string): Promise<number> {
    return [...this.currentHeads.entries()].filter(([key, id]) => key.startsWith(`${generationId}\0`)
      && ['missing', 'detached', 'conflict'].includes(this.reservations.get(id)?.state ?? '')).length;
  }

  history(): readonly DriveFolderReservation[] {
    return Object.freeze([...this.reservations.values()].map((reservation) => this.clone(reservation)));
  }

  private currentFor(generationId: string, normalizedPath: string): DriveFolderReservation | null {
    const id = this.currentHeads.get(keyFor(generationId, normalizedPath));
    return id === undefined ? null : this.reservations.get(id) ?? null;
  }

  private clone(reservation: DriveFolderReservation): DriveFolderReservation {
    return DriveFolderReservation.restore({ ...reservation });
  }

  private cloneNullable(reservation: DriveFolderReservation | null): DriveFolderReservation | null {
    return reservation === null ? null : this.clone(reservation);
  }
}

function keyFor(generationId: string, normalizedPath: string): string {
  return `${generationId}\0${normalizedPath}`;
}

function matches(current: DriveFolderReservation | null, expected: { id: string; revision: number } | null): boolean {
  return expected === null ? current === null : current?.id === expected.id && current.revision === expected.revision;
}

function restoreWithState(reservation: DriveFolderReservation, state: 'missing' | 'superseded', nowMs: number): DriveFolderReservation {
  const snapshot: DriveFolderReservationSnapshot = {
    ...reservation,
    state,
    revision: reservation.revision + 1,
    updatedAtMs: nowMs,
  };
  return DriveFolderReservation.restore(snapshot);
}

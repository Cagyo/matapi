import type {
  DriveFolderReservationRepositoryPort,
  ReserveDriveFolder,
} from '../../application/ports/drive-folder-reservation-repository.port';
import {
  DriveFolderReservation,
  type DriveFolderReservationSnapshot,
} from '../../domain/drive-folder-reservation.entity';

const REVALIDATION_CLAIM_DURATION_MS = 60_000;

/** Deterministic in-memory parity adapter for folder-reservation use cases. */
export class InMemoryDriveFolderReservationRepository implements DriveFolderReservationRepositoryPort {
  private readonly reservations = new Map<string, DriveFolderReservation>();
  private readonly currentHeads = new Map<string, string>();

  async loadCurrent(generationId: string, normalizedPath: string): Promise<DriveFolderReservation | null> {
    return this.cloneNullable(this.currentFor(generationId, normalizedPath));
  }

  async claimNextBlockedRevalidation(input: {
    generationId: string;
    nowMs: number;
    claimUntilMs: number;
  }): Promise<DriveFolderReservation | null> {
    const blockedHeads = this.blockedHeads(input.generationId);
    if (blockedHeads.some((reservation) => isActiveRevalidationClaim(
      reservation,
      input.nowMs,
    ))) return null;
    const current = blockedHeads.find((reservation) => reservation.nextRevalidationAtMs !== null
      && reservation.nextRevalidationAtMs <= input.nowMs);
    if (current === undefined) return null;
    const claimed = DriveFolderReservation.restore({
      ...current,
      revision: current.revision + 1,
      nextRevalidationAtMs: input.claimUntilMs,
      updatedAtMs: input.nowMs,
    });
    this.reservations.set(claimed.id, claimed);
    return this.clone(claimed);
  }

  async requestNextBlockedRevalidation(input: {
    generationId: string;
    nowMs: number;
  }): Promise<DriveFolderReservation | null> {
    const blockedHeads = this.blockedHeads(input.generationId);
    if (blockedHeads.some((reservation) => isActiveRevalidationClaim(
      reservation,
      input.nowMs,
    ))) return null;
    const current = blockedHeads[0];
    if (current === undefined) return null;
    const requested = DriveFolderReservation.restore({
      ...current,
      revision: current.revision + 1,
      nextRevalidationAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
    });
    this.reservations.set(requested.id, requested);
    return this.clone(requested);
  }

  async restoreDetached(
    id: string,
    expectedRevision: number,
    nowMs: number,
  ): Promise<DriveFolderReservation | null> {
    const current = this.reservations.get(id);
    if (!this.isCurrentBlockedHead(current, 'detached', expectedRevision)) return null;
    const restored = current.restoreAfterRevalidation(nowMs);
    this.reservations.set(restored.id, restored);
    return this.clone(restored);
  }

  async adoptConflictCandidate(input: {
    expected: { id: string; revision: number };
    replacement: ReserveDriveFolder;
    nowMs: number;
  }): Promise<
    | { kind: 'stored'; reservation: DriveFolderReservation }
    | { kind: 'lost'; current: DriveFolderReservation | null }
  > {
    const current = this.reservations.get(input.expected.id);
    const currentForPath = current === undefined
      ? null
      : this.currentFor(current.generationId, current.normalizedPath);
    if (!this.isCurrentBlockedHead(current, 'conflict', input.expected.revision)
      || !sameReservationIdentity(current, input.replacement)
      || this.reservations.has(input.replacement.id)
      || this.hasFolderId(input.replacement.folderId)) {
      return { kind: 'lost', current: this.cloneNullable(currentForPath) };
    }

    const historical = DriveFolderReservation.restore({
      ...current,
      currentSlot: null,
      revision: current.revision + 1,
      updatedAtMs: input.nowMs,
    });
    const replacement = DriveFolderReservation.reserve({
      ...input.replacement,
      nowMs: input.nowMs,
    }).verify(input.nowMs);
    this.reservations.set(historical.id, historical);
    this.reservations.set(replacement.id, replacement);
    this.currentHeads.set(
      keyFor(replacement.generationId, replacement.normalizedPath),
      replacement.id,
    );
    return { kind: 'stored', reservation: this.clone(replacement) };
  }

  async rescheduleBlockedRevalidation(input: {
    id: string;
    expectedRevision: number;
    errorCode: string;
    nowMs: number;
    nextRevalidationAtMs: number;
  }): Promise<DriveFolderReservation | null> {
    const current = this.reservations.get(input.id);
    if (!this.isCurrentBlockedHead(current, undefined, input.expectedRevision)) return null;
    const rescheduled = current.rescheduleRevalidation(
      input.errorCode,
      input.nowMs,
      input.nextRevalidationAtMs,
    );
    this.reservations.set(rescheduled.id, rescheduled);
    return this.clone(rescheduled);
  }

  async compareAndSetCurrent(input: {
    expected: { id: string; revision: number } | null;
    replacement: ReserveDriveFolder;
    nowMs: number;
  }): Promise<{ kind: 'stored'; reservation: DriveFolderReservation } | { kind: 'lost'; current: DriveFolderReservation | null }> {
    const current = this.currentFor(input.replacement.generationId, input.replacement.normalizedPath);
    if (!matches(current, input.expected) || this.reservations.has(input.replacement.id) || this.hasFolderId(input.replacement.folderId)) {
      return { kind: 'lost', current: this.cloneNullable(current) };
    }
    const reservation = DriveFolderReservation.reserve({ ...input.replacement, nowMs: input.nowMs });
    this.reservations.set(reservation.id, reservation);
    this.currentHeads.set(keyFor(reservation.generationId, reservation.normalizedPath), reservation.id);
    return { kind: 'stored', reservation: this.clone(reservation) };
  }

  async appendMissingIdentity(input: {
    reservation: ReserveDriveFolder;
    nowMs: number;
  }): Promise<'stored' | 'exists'> {
    if (this.hasFolderId(input.reservation.folderId)) return 'exists';
    if (this.reservations.has(input.reservation.id)) {
      throw new Error('Drive folder reservation ID is already stored');
    }
    const missing = missingIdentity(input.reservation, input.nowMs);
    this.reservations.set(missing.id, missing);
    return 'stored';
  }

  async markVerified(id: string, expectedRevision: number, nowMs: number): Promise<DriveFolderReservation | null> {
    const current = this.reservations.get(id);
    if (current?.revision !== expectedRevision) return null;
    const verified = current.verify(nowMs);
    this.reservations.set(id, verified);
    return this.clone(verified);
  }

  async markBlocked(
    id: string,
    expectedRevision: number,
    state: 'detached' | 'conflict',
    errorCode: string,
    nowMs: number,
    nextRevalidationAtMs: number | null = null,
  ): Promise<DriveFolderReservation | null> {
    const current = this.reservations.get(id);
    if (current?.revision !== expectedRevision) return null;
    const blocked = current.block(state, errorCode, nowMs, nextRevalidationAtMs);
    this.reservations.set(id, blocked);
    return this.clone(blocked);
  }

  async replaceMissing(input: {
    expected: { id: string; revision: number; folderId: string };
    replacement: ReserveDriveFolder;
    nowMs: number;
  }): Promise<{ kind: 'stored'; reservation: DriveFolderReservation } | { kind: 'lost'; current: DriveFolderReservation | null }> {
    const current = this.currentFor(input.replacement.generationId, input.replacement.normalizedPath);
    if (current?.id !== input.expected.id || current.revision !== input.expected.revision
      || current.folderId !== input.expected.folderId || this.reservations.has(input.replacement.id)
      || this.hasFolderId(input.replacement.folderId)) {
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

  /** Test-only fixture helper that creates the complete prefix chain. */
  async seedBlockedPath(
    generationId: string,
    dayPath: string,
    state: 'detached' | 'conflict',
    blockedLevel: 'year' | 'month' | 'day' = 'day',
  ): Promise<void> {
    const segments = dayPath.split('/');
    const paths = [segments[0], segments.slice(0, 2).join('/'), dayPath];
    let parentFolderId = 'motion-root';
    for (const [index, normalizedPath] of paths.entries()) {
      const suffix = this.reservations.size;
      const stored = await this.compareAndSetCurrent({
        expected: null,
        replacement: {
          id: `seed-reservation-${suffix}`,
          installationId: 'installation-1',
          generationId,
          normalizedPath,
          level: ['year', 'month', 'day'][index] as 'year' | 'month' | 'day',
          segmentName: segments[index],
          folderId: `seed-folder-${suffix}`,
          parentFolderId,
        },
        nowMs: index + 1,
      });
      if (stored.kind !== 'stored') throw new Error('Seed folder reservation lost');
      const verified = await this.markVerified(
        stored.reservation.id, stored.reservation.revision, index + 10,
      );
      if (verified === null) throw new Error('Seed folder verification lost');
      if (['year', 'month', 'day'][index] === blockedLevel) {
        const blocked = await this.markBlocked(
          verified.id, verified.revision, state, 'seeded_block', index + 20,
        );
        if (blocked === null) throw new Error('Seed folder block lost');
      }
      parentFolderId = stored.reservation.folderId;
    }
  }

  history(): readonly DriveFolderReservation[] {
    return Object.freeze([...this.reservations.values()].map((reservation) => this.clone(reservation)));
  }

  private currentFor(generationId: string, normalizedPath: string): DriveFolderReservation | null {
    const id = this.currentHeads.get(keyFor(generationId, normalizedPath));
    return id === undefined ? null : this.reservations.get(id) ?? null;
  }

  private hasFolderId(folderId: string): boolean {
    return [...this.reservations.values()].some((reservation) => reservation.folderId === folderId);
  }

  private blockedHeads(generationId: string): DriveFolderReservation[] {
    return [...this.currentHeads.entries()]
      .filter(([key]) => key.startsWith(`${generationId}\0`))
      .map(([, id]) => this.reservations.get(id))
      .filter((reservation): reservation is DriveFolderReservation => reservation?.currentSlot === 1
        && (reservation.state === 'detached' || reservation.state === 'conflict'))
      .sort(compareRevalidationOrder);
  }

  private isCurrentBlockedHead(
    reservation: DriveFolderReservation | undefined,
    state: 'detached' | 'conflict' | undefined,
    expectedRevision: number,
  ): reservation is DriveFolderReservation {
    return reservation?.currentSlot === 1
      && reservation.revision === expectedRevision
      && (state === undefined
        ? reservation.state === 'detached' || reservation.state === 'conflict'
        : reservation.state === state)
      && this.currentHeads.get(keyFor(reservation.generationId, reservation.normalizedPath))
        === reservation.id;
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

function compareRevalidationOrder(
  left: DriveFolderReservation,
  right: DriveFolderReservation,
): number {
  const leftDeadline = left.nextRevalidationAtMs ?? Number.NEGATIVE_INFINITY;
  const rightDeadline = right.nextRevalidationAtMs ?? Number.NEGATIVE_INFINITY;
  return leftDeadline - rightDeadline
    || compareText(left.normalizedPath, right.normalizedPath)
    || compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isActiveRevalidationClaim(
  reservation: DriveFolderReservation,
  nowMs: number,
): boolean {
  const deadline = reservation.nextRevalidationAtMs;
  return deadline !== null
    && deadline > nowMs
    && deadline - reservation.updatedAtMs === REVALIDATION_CLAIM_DURATION_MS;
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

function restoreWithState(reservation: DriveFolderReservation, state: 'missing' | 'superseded', nowMs: number): DriveFolderReservation {
  const snapshot: DriveFolderReservationSnapshot = {
    ...reservation,
    state,
    currentSlot: null,
    revision: reservation.revision + 1,
    updatedAtMs: nowMs,
  };
  return DriveFolderReservation.restore(snapshot);
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

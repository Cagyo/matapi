import { DriveObjectConflictError } from './errors/drive-object-conflict.error';

export type DriveFolderLevel = 'year' | 'month' | 'day';
export type DriveFolderReservationState =
  | 'reserved' | 'verified' | 'missing' | 'detached' | 'conflict' | 'superseded';

export interface DriveFolderReservationSnapshot {
  id: string;
  installationId: string;
  generationId: string;
  normalizedPath: string;
  level: DriveFolderLevel;
  segmentName: string;
  folderId: string;
  parentFolderId: string;
  state: DriveFolderReservationState;
  currentSlot: 1 | null;
  revision: number;
  errorCode: string | null;
  revalidationFailureStreak: number;
  nextRevalidationAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  verifiedAtMs: number | null;
}

export interface ReserveDriveFolder {
  id: string;
  installationId: string;
  generationId: string;
  normalizedPath: string;
  level: DriveFolderLevel;
  segmentName: string;
  folderId: string;
  parentFolderId: string;
  nowMs: number;
}

export class DriveFolderReservation implements DriveFolderReservationSnapshot {
  readonly id!: string;
  readonly installationId!: string;
  readonly generationId!: string;
  readonly normalizedPath!: string;
  readonly level!: DriveFolderLevel;
  readonly segmentName!: string;
  readonly folderId!: string;
  readonly parentFolderId!: string;
  readonly state!: DriveFolderReservationState;
  readonly currentSlot!: 1 | null;
  readonly revision!: number;
  readonly errorCode!: string | null;
  readonly revalidationFailureStreak!: number;
  readonly nextRevalidationAtMs!: number | null;
  readonly createdAtMs!: number;
  readonly updatedAtMs!: number;
  readonly verifiedAtMs!: number | null;

  private constructor(snapshot: DriveFolderReservationSnapshot) {
    validateSnapshot(snapshot);
    Object.assign(this, snapshot);
    Object.freeze(this);
  }

  static reserve(input: ReserveDriveFolder): DriveFolderReservation {
    return new DriveFolderReservation({
      ...input,
      state: 'reserved',
      currentSlot: 1,
      revision: 0,
      errorCode: null,
      revalidationFailureStreak: 0,
      nextRevalidationAtMs: null,
      createdAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
      verifiedAtMs: null,
    });
  }

  static restore(snapshot: DriveFolderReservationSnapshot): DriveFolderReservation {
    return new DriveFolderReservation(snapshot);
  }

  verify(nowMs: number): DriveFolderReservation {
    return this.transition('verified', nowMs, { verifiedAtMs: nowMs, errorCode: null });
  }

  block(
    state: Extract<DriveFolderReservationState, 'detached' | 'conflict'>,
    errorCode: string,
    nowMs: number,
    nextRevalidationAtMs: number | null = null,
  ): DriveFolderReservation {
    requireText(errorCode, 'Drive folder reservation error code');
    requireNullableNonNegativeInteger(nextRevalidationAtMs, 'Drive folder reservation revalidation time');
    return this.transition(state, nowMs, {
      errorCode,
      revalidationFailureStreak: nextRevalidationAtMs === null
        ? this.revalidationFailureStreak
        : this.revalidationFailureStreak + 1,
      nextRevalidationAtMs,
    });
  }

  restoreAfterRevalidation(nowMs: number): DriveFolderReservation {
    this.requireCurrentBlockedHead();
    return new DriveFolderReservation({
      ...this,
      state: 'verified',
      errorCode: null,
      revalidationFailureStreak: 0,
      nextRevalidationAtMs: null,
      verifiedAtMs: nowMs,
      updatedAtMs: nowMs,
      revision: this.revision + 1,
    });
  }

  rescheduleRevalidation(
    errorCode: string,
    nowMs: number,
    nextRevalidationAtMs: number,
  ): DriveFolderReservation {
    this.requireCurrentBlockedHead();
    requireText(errorCode, 'Drive folder reservation error code');
    requireNonNegativeInteger(nextRevalidationAtMs, 'Drive folder reservation revalidation time');
    return new DriveFolderReservation({
      ...this,
      errorCode,
      revalidationFailureStreak: this.revalidationFailureStreak + 1,
      nextRevalidationAtMs,
      updatedAtMs: nowMs,
      revision: this.revision + 1,
    });
  }

  private requireCurrentBlockedHead(): void {
    if (this.currentSlot !== 1 || !['detached', 'conflict'].includes(this.state)) {
      throw new DriveObjectConflictError('Drive folder reservation is not a current blocked head');
    }
  }

  private transition(
    state: DriveFolderReservationState,
    nowMs: number,
    update: Partial<Pick<DriveFolderReservationSnapshot,
      'errorCode' | 'verifiedAtMs' | 'currentSlot' | 'revalidationFailureStreak' | 'nextRevalidationAtMs'>> = {},
  ): DriveFolderReservation {
    if (this.state === state) return this;
    const legal: Record<DriveFolderReservationState, readonly DriveFolderReservationState[]> = {
      reserved: ['verified', 'missing', 'detached', 'conflict', 'superseded'],
      verified: ['missing', 'detached', 'conflict', 'superseded'],
      missing: ['verified', 'detached', 'conflict', 'superseded'],
      detached: [],
      conflict: [],
      superseded: [],
    };
    if (!legal[this.state].includes(state)) {
      throw new DriveObjectConflictError(`Drive folder reservation cannot transition from ${this.state} to ${state}`);
    }
    return new DriveFolderReservation({
      ...this,
      ...update,
      state,
      updatedAtMs: nowMs,
      revision: this.revision + 1,
    });
  }
}

function validateSnapshot(snapshot: DriveFolderReservationSnapshot): void {
  for (const [value, label] of [
    [snapshot.id, 'Drive folder reservation ID'],
    [snapshot.installationId, 'Installation ID'],
    [snapshot.generationId, 'Drive generation ID'],
    [snapshot.normalizedPath, 'Normalized Drive folder path'],
    [snapshot.segmentName, 'Drive folder segment name'],
    [snapshot.folderId, 'Reserved Drive folder ID'],
    [snapshot.parentFolderId, 'Reserved Drive parent folder ID'],
  ] as const) requireText(value, label);
  if (!['year', 'month', 'day'].includes(snapshot.level)) throw new DriveObjectConflictError('Drive folder level is malformed');
  if (!['reserved', 'verified', 'missing', 'detached', 'conflict', 'superseded'].includes(snapshot.state)) throw new DriveObjectConflictError('Drive folder reservation state is malformed');
  if (snapshot.currentSlot !== 1 && snapshot.currentSlot !== null) throw new DriveObjectConflictError('Drive folder reservation current slot is malformed');
  for (const [value, label] of [[snapshot.revision, 'Drive folder reservation revision'], [snapshot.createdAtMs, 'Drive folder reservation creation time'], [snapshot.updatedAtMs, 'Drive folder reservation update time']] as const) requireNonNegativeInteger(value, label);
  if (snapshot.errorCode !== null) requireText(snapshot.errorCode, 'Drive folder reservation error code');
  requireNonNegativeInteger(snapshot.revalidationFailureStreak, 'Drive folder reservation revalidation failure streak');
  requireNullableNonNegativeInteger(snapshot.nextRevalidationAtMs, 'Drive folder reservation revalidation time');
  if (snapshot.verifiedAtMs !== null) requireNonNegativeInteger(snapshot.verifiedAtMs, 'Drive folder reservation verification time');
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value) throw new DriveObjectConflictError(`${label} is missing`);
}

function requireNonNegativeInteger(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new DriveObjectConflictError(`${label} is malformed`);
}

function requireNullableNonNegativeInteger(value: unknown, label: string): void {
  if (value !== null) requireNonNegativeInteger(value, label);
}

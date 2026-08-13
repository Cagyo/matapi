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

  block(state: Extract<DriveFolderReservationState, 'detached' | 'conflict'>, errorCode: string, nowMs: number): DriveFolderReservation {
    requireText(errorCode, 'Drive folder reservation error code');
    return this.transition(state, nowMs, { errorCode });
  }

  private transition(
    state: DriveFolderReservationState,
    nowMs: number,
    update: Partial<Pick<DriveFolderReservationSnapshot, 'errorCode' | 'verifiedAtMs' | 'currentSlot'>> = {},
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
  if (snapshot.verifiedAtMs !== null) requireNonNegativeInteger(snapshot.verifiedAtMs, 'Drive folder reservation verification time');
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value) throw new DriveObjectConflictError(`${label} is missing`);
}

function requireNonNegativeInteger(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new DriveObjectConflictError(`${label} is malformed`);
}

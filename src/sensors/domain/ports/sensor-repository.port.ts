import { Sensor, SensorSeverity, SensorType } from '../sensor';

export const SENSOR_REPOSITORY = Symbol('SENSOR_REPOSITORY');

/** Payload for inserting a brand-new sensor. */
export interface NewSensor {
  id: string;
  name: string;
  type: SensorType;
  config: Record<string, unknown>;
  debounceMs: number;
  severity: SensorSeverity;
  createdAt: Date;
}

/** Partial patch for `update`. Only present fields are written. */
export interface SensorPatch {
  name?: string;
  config?: Record<string, unknown>;
  debounceMs?: number;
  severity?: SensorSeverity;
  updatedAt: Date;
}

/**
 * A batch of sensor changes applied atomically by `/import_config`
 * (spec 16 § /import_config — Apply). Archives, then updates, then inserts
 * must all commit in a single transaction or none at all.
 */
export interface SensorImportBatch {
  inserts: NewSensor[];
  updates: { id: string; patch: SensorPatch }[];
  archives: { id: string; archivedAt: Date }[];
}

export interface SensorRepositoryPort {
  /** All sensors with `enabled = true`. */
  loadEnabled(): Promise<Sensor[]>;
  /** Persist `lastValue` + `lastValueAt` for a sensor. */
  updateState(id: string, value: string, at: Date): Promise<void>;

  /** Lookup a single (active) sensor by id, or `null`. */
  findById(id: string): Promise<Sensor | null>;
  /** Lookup an active sensor by exact name, or `null`. */
  findByName(name: string): Promise<Sensor | null>;
  /**
   * Resolve the active digital sensor that owns a GPIO pin, or `null` if
   * the pin is free. Used by `AddSensorUseCase` / `ModifySensorUseCase`
   * for uniqueness enforcement (spec 03 § Validations).
   */
  findActivePinOwner(pin: number): Promise<Sensor | null>;
  /** Insert a new sensor row with `enabled = true`. */
  create(sensor: NewSensor): Promise<Sensor>;
  /** Patch an existing sensor row (by id). Throws if no row exists. */
  update(id: string, patch: SensorPatch): Promise<Sensor>;
  /**
   * Move a sensor from `sensors` to `sensors_archive` atomically.
   * Spec 10 § /config remove + spec 01 § Sensor Deletion Flow.
   */
  archive(id: string, archivedAt: Date): Promise<void>;
  /**
   * Apply a full-replacement import (archive + update + insert) atomically.
   * Spec 16 § /import_config — Apply.
   */
  applyImport(batch: SensorImportBatch): Promise<void>;
}

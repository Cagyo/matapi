export const USER_SENSOR_MUTE_REPOSITORY = Symbol('USER_SENSOR_MUTE_REPOSITORY');

/** Per-user, per-sensor notification mute (spec 12 — `/mute <sensor>`). */
export interface UserSensorMuteRepositoryPort {
  isMuted(userId: number, sensorId: string): Promise<boolean>;
  mute(userId: number, sensorId: string): Promise<void>;
  unmute(userId: number, sensorId: string): Promise<void>;
  /** Sensor ids currently muted for the given user. */
  listForUser(userId: number): Promise<string[]>;
  /** Number of sensors currently muted for the given user. */
  countForUser(userId: number): Promise<number>;
}

import type { NotificationTargetRef } from '../home-session';

export const USER_SENSOR_MUTE_REPOSITORY = Symbol('USER_SENSOR_MUTE_REPOSITORY');

/** Per-user, per-target notification mute. Legacy string inputs mean sensors. */
export interface UserSensorMuteRepositoryPort {
  isMuted(userId: number, target: NotificationTargetRef | string): Promise<boolean>;
  mute(userId: number, target: NotificationTargetRef | string): Promise<void>;
  unmute(userId: number, target: NotificationTargetRef | string): Promise<void>;
  /** Typed notification targets currently muted for the given user. */
  listForUser(userId: number): Promise<NotificationTargetRef[]>;
  /** Number of stored muted targets for the given user. */
  countForUser(userId: number): Promise<number>;
}

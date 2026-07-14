import { Inject, Injectable } from '@nestjs/common';
import {
  TIMEZONE_OPTIONS,
  TimezoneOptions,
} from '../../config/application/ports/timezone-options.port';
import { CLOCK, ClockPort } from '../../events/domain/ports/clock.port';
import { isInQuietHours } from '../../events/domain/quiet-hours';
import {
  classifySensorState,
  ClassifiedSensorState,
  normalizedSensorName,
} from '../../sensors/domain/sensor-state-classifier';
import {
  SENSOR_QUERY,
  SensorQueryPort,
} from '../../sensors/domain/ports/sensor-query.port';
import { HomeHealthSnapshot, isHomeHealthFresh } from '../domain/home-health-snapshot';
import { UserNotFoundError } from '../domain/errors/user-not-found.error';
import {
  USER_REPOSITORY,
  UserRepositoryPort,
} from '../domain/ports/user-repository.port';
import {
  USER_SENSOR_MUTE_REPOSITORY,
  UserSensorMuteRepositoryPort,
} from '../domain/ports/user-sensor-mute-repository.port';
import {
  HOME_HEALTH_SNAPSHOT,
  HomeHealthSnapshotPort,
} from './ports/home-health-snapshot.port';
import { deriveHomeVerdict, HomeVerdict } from './home-verdict';

export type HomeNotificationState =
  | { kind: 'legacy_pause' }
  | { kind: 'timed_pause'; until: Date }
  | { kind: 'quiet_hours'; until: string }
  | { kind: 'paused_targets'; count: number }
  | { kind: 'normal' };

export interface HomeSummary {
  verdict: HomeVerdict;
  sensors: readonly ClassifiedSensorState[];
  attention: readonly ClassifiedSensorState[];
  attentionTotal: number;
  knownCount: number;
  unknownCount: number;
  health: HomeHealthSnapshot | null;
  healthFresh: boolean;
  notificationState: HomeNotificationState;
}

/**
 * Read-only projection for the Home dashboard. Health probing belongs to the
 * separate refresh path; this use case only consumes its cached snapshot.
 */
@Injectable()
export class GetHomeSummaryUseCase {
  constructor(
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(USER_SENSOR_MUTE_REPOSITORY)
    private readonly mutes: UserSensorMuteRepositoryPort,
    @Inject(HOME_HEALTH_SNAPSHOT)
    private readonly snapshots: HomeHealthSnapshotPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(TIMEZONE_OPTIONS) private readonly timezone: TimezoneOptions,
  ) {}

  async execute(userId: number): Promise<HomeSummary> {
    const user = await this.users.findByTelegramId(userId);
    if (!user) throw new UserNotFoundError(String(userId));

    const now = this.clock.now();
    const [enabled, mutedTargetCount] = await Promise.all([
      this.sensors.listEnabled(),
      this.mutes.countForUser(userId),
    ]);
    const health = this.snapshots.get();
    const classified = enabled.map(classifySensorState);
    const attention = classified
      .filter(({ level }) => level === 'critical' || level === 'warning')
      .sort(compareAttention);
    const unknownCount = classified.filter(({ level }) => level === 'unknown').length;

    return {
      verdict: deriveHomeVerdict({ sensors: classified, health, now }),
      sensors: classified,
      attention: attention.slice(0, 3),
      attentionTotal: attention.length,
      knownCount: classified.length - unknownCount,
      unknownCount,
      health,
      healthFresh: health !== null && isHomeHealthFresh(health.completedAt, now),
      notificationState: notificationStateFor(user, now, mutedTargetCount, this.timezone),
    };
  }
}

function compareAttention(left: ClassifiedSensorState, right: ClassifiedSensorState): number {
  const levelDifference = attentionPriority(left.level) - attentionPriority(right.level);
  if (levelDifference !== 0) return levelDifference;

  const leftName = normalizedSensorName(left.sensor.name);
  const rightName = normalizedSensorName(right.sensor.name);
  if (leftName < rightName) return -1;
  if (leftName > rightName) return 1;
  if (left.sensor.id < right.sensor.id) return -1;
  if (left.sensor.id > right.sensor.id) return 1;
  return 0;
}

function attentionPriority(level: ClassifiedSensorState['level']): number {
  return level === 'critical' ? 0 : level === 'warning' ? 1 : 2;
}

function notificationStateFor(
  user: { muted: boolean; nonCriticalPausedUntil: Date | null; quietStart: string | null; quietEnd: string | null },
  now: Date,
  mutedTargetCount: number,
  timezone: TimezoneOptions,
): HomeNotificationState {
  if (user.muted) return { kind: 'legacy_pause' };
  if (user.nonCriticalPausedUntil && user.nonCriticalPausedUntil > now) {
    return { kind: 'timed_pause', until: user.nonCriticalPausedUntil };
  }
  if (isInQuietHours(user, now, timezone.timezone)) {
    return { kind: 'quiet_hours', until: user.quietEnd! };
  }
  if (mutedTargetCount > 0) return { kind: 'paused_targets', count: mutedTargetCount };
  return { kind: 'normal' };
}

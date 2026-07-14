import { describe, expect, it, vi } from 'vitest';
import { TimezoneOptions } from '../../../src/config/application/ports/timezone-options.port';
import { SensorQueryPort } from '../../../src/sensors/domain/ports/sensor-query.port';
import { Sensor } from '../../../src/sensors/domain/sensor';
import { HomeHealthSnapshot } from '../../../src/telegram/domain/home-health-snapshot';
import { UserNotFoundError } from '../../../src/telegram/domain/errors/user-not-found.error';
import { UserRepositoryPort } from '../../../src/telegram/domain/ports/user-repository.port';
import { UserSensorMuteRepositoryPort } from '../../../src/telegram/domain/ports/user-sensor-mute-repository.port';
import { User } from '../../../src/telegram/domain/user.entity';
import { GetHomeSummaryUseCase } from '../../../src/telegram/application/get-home-summary.use-case';
import { NotificationTarget, NotificationTargetDirectory } from '../../../src/telegram/application/notification-target-directory.service';

const NOW = new Date('2030-01-01T12:00:00.000Z');
const TIMEZONE: TimezoneOptions = { timezone: 'UTC' };

function sensor(
  id: string,
  overrides: Partial<Sensor> = {},
): Sensor {
  return {
    id,
    name: id,
    type: 'digital',
    config: {},
    enabled: true,
    debounceMs: 0,
    severity: 'info',
    lastValue: 'false',
    lastValueAt: NOW,
    ...overrides,
  };
}

function user(overrides: Partial<User> = {}): User {
  return {
    telegramId: 1,
    name: 'Ada',
    role: 'user',
    locale: 'en',
    muted: false,
    nonCriticalPausedUntil: null,
    notificationPauseRevision: 0,
    quietStart: null,
    quietEnd: null,
    createdAt: NOW,
    ...overrides,
  };
}

function health(ids: string[] = ['a']): HomeHealthSnapshot {
  return {
    completedAt: NOW,
    enabledSensorIds: ids,
    onlineSensorIds: ids,
    missingSensorIds: [],
    failedSensorIds: [],
    timedOutSensorIds: [],
    offlineSensorIds: [],
  };
}

function useCase(input: {
  sensors?: Sensor[];
  currentUser?: User | null;
  mutedTargetCount?: number;
  mutedTargets?: readonly NotificationTarget[];
  snapshot?: HomeHealthSnapshot | null;
}) {
  const query = {
    listEnabled: vi.fn(async () => input.sensors ?? [sensor('a')]),
  } as unknown as SensorQueryPort;
  const users = {
    findByTelegramId: vi.fn(async () => input.currentUser === undefined ? user() : input.currentUser),
  } as unknown as UserRepositoryPort;
  const mutes = {
    countForUser: vi.fn(async () => input.mutedTargetCount ?? 0),
  } as unknown as UserSensorMuteRepositoryPort;
  const targetDirectory = {
    listEnabled: vi.fn(async () => input.mutedTargets ?? Array.from(
      { length: input.mutedTargetCount ?? 0 },
      (_, index) => ({
        ref: { kind: 'sensor' as const, id: `muted-${index}` },
        name: `Muted ${index}`,
        kind: 'sensor' as const,
        muted: true,
      }),
    )),
  } as unknown as NotificationTargetDirectory;
  const snapshots = { get: vi.fn(() => input.snapshot ?? health()) };
  const summary = new GetHomeSummaryUseCase(query, users, snapshots, { now: () => NOW }, TIMEZONE, targetDirectory);
  return { summary, query, users, mutes, targetDirectory, snapshots };
}

describe('GetHomeSummaryUseCase', () => {
  it('uses only cached reads and returns complete counts with capped ordered attention', async () => {
    const { summary, query, users, mutes, targetDirectory, snapshots } = useCase({
      sensors: [
        sensor('4', { name: '  bravo  ', severity: 'warning', lastValue: 'true' }),
        sensor('2', { name: 'Zulu', severity: 'critical', lastValue: 'true' }),
        sensor('1', { name: 'alpha', severity: 'critical', lastValue: 'true' }),
        sensor('3', { name: 'charlie', severity: 'warning', lastValue: 'true' }),
        sensor('5', { lastValue: null }),
      ],
      snapshot: health(['1', '2', '3', '4', '5']),
      mutedTargetCount: 2,
    });

    await expect(summary.execute(1)).resolves.toMatchObject({
      verdict: 'attention',
      attentionTotal: 4,
      knownCount: 4,
      unknownCount: 1,
      healthFresh: true,
      notificationState: { kind: 'paused_targets', count: 2 },
      attention: [
        { sensor: { id: '1' }, level: 'critical' },
        { sensor: { id: '2' }, level: 'critical' },
        { sensor: { id: '4' }, level: 'warning' },
      ],
    });
    expect(query.listEnabled).toHaveBeenCalledTimes(1);
    expect(users.findByTelegramId).toHaveBeenCalledTimes(1);
    expect(mutes.countForUser).not.toHaveBeenCalled();
    expect(targetDirectory.listEnabled).toHaveBeenCalledWith(1);
    expect(snapshots.get).toHaveBeenCalledTimes(1);
  });

  it('orders equal-priority attention by normalized Unicode name then immutable ID', async () => {
    const { summary } = useCase({
      sensors: [
        sensor('z-id', { name: '  Ａ  ', severity: 'critical', lastValue: 'true' }),
        sensor('a-id', { name: 'a', severity: 'critical', lastValue: 'true' }),
        sensor('angstrom', { name: 'Ångström', severity: 'critical', lastValue: 'true' }),
        sensor('zebra', { name: 'zebra', severity: 'critical', lastValue: 'true' }),
      ],
      snapshot: health(['z-id', 'a-id', 'angstrom', 'zebra']),
    });

    await expect(summary.execute(1)).resolves.toMatchObject({
      attention: [
        { sensor: { id: 'a-id' } },
        { sensor: { id: 'z-id' } },
        { sensor: { id: 'zebra' } },
      ],
    });
  });

  it('fails when the current user is absent', async () => {
    const { summary, mutes, snapshots } = useCase({ currentUser: null });

    await expect(summary.execute(404)).rejects.toEqual(new UserNotFoundError('404'));
    expect(mutes.countForUser).not.toHaveBeenCalled();
    expect(snapshots.get).not.toHaveBeenCalled();
  });

  it.each([
    ['legacy pause', user({ muted: true, nonCriticalPausedUntil: new Date(NOW.getTime() + 60_000), quietStart: '00:00', quietEnd: '23:59' }), 4, { kind: 'legacy_pause' }],
    ['active timed pause', user({ nonCriticalPausedUntil: new Date(NOW.getTime() + 60_000), quietStart: '00:00', quietEnd: '23:59' }), 4, { kind: 'timed_pause', until: new Date(NOW.getTime() + 60_000) }],
    ['active quiet hours', user({ quietStart: '00:00', quietEnd: '23:59' }), 4, { kind: 'quiet_hours', until: '23:59' }],
    ['paused target count', user(), 4, { kind: 'paused_targets', count: 4 }],
    ['normal notifications', user(), 0, { kind: 'normal' }],
    ['expired timed pause', user({ nonCriticalPausedUntil: NOW }), 0, { kind: 'normal' }],
  ] as const)('prioritizes %s', async (_case, currentUser, mutedTargetCount, expected) => {
    const { summary } = useCase({ currentUser, mutedTargetCount });
    await expect(summary.execute(1)).resolves.toMatchObject({ notificationState: expected });
  });

  it('uses the requested user\'s target count', async () => {
    const { summary, targetDirectory } = useCase({ mutedTargetCount: 7 });
    await expect(summary.execute(55)).resolves.toMatchObject({
      notificationState: { kind: 'paused_targets', count: 7 },
    });
    expect(targetDirectory.listEnabled).toHaveBeenCalledWith(55);
  });

  it('excludes stale muted targets from the Home notification count', async () => {
    const { summary } = useCase({ mutedTargetCount: 1, mutedTargets: [] });

    await expect(summary.execute(1)).resolves.toMatchObject({
      notificationState: { kind: 'normal' },
    });
  });

  it('treats a future health snapshot as unavailable and not fresh', async () => {
    const { summary } = useCase({
      snapshot: { ...health(), completedAt: new Date(NOW.getTime() + 1) },
    });

    await expect(summary.execute(1)).resolves.toMatchObject({
      verdict: 'unavailable',
      healthFresh: false,
    });
  });
});

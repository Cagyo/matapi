import { Inject, Injectable } from '@nestjs/common';
import { MEDIA_REPOSITORY, type MediaRepositoryPort } from '../../camera/domain/ports/media-repository.port';
import { SENSOR_QUERY, type SensorQueryPort } from '../../sensors/domain/ports/sensor-query.port';
import type { NotificationTargetRef } from '../domain/home-session';
import { USER_SENSOR_MUTE_REPOSITORY, type UserSensorMuteRepositoryPort } from '../domain/ports/user-sensor-mute-repository.port';

export interface NotificationTarget {
  ref: NotificationTargetRef;
  name: string;
  kind: NotificationTargetRef['kind'];
  muted: boolean;
}

export interface NotificationTargetPage {
  targets: readonly NotificationTarget[];
  requestedPage: number;
  page: number;
  pageCount: number;
  total: number;
  clamped: boolean;
}

export interface NotificationTargetDirectory {
  listEnabled(userId: number): Promise<readonly NotificationTarget[]>;
  findEnabled(ref: NotificationTargetRef, userId: number): Promise<NotificationTarget | null>;
  findEnabledByName(name: string, userId: number): Promise<NotificationTarget | null>;
}

@Injectable()
export class NotificationTargetDirectoryService implements NotificationTargetDirectory {
  constructor(
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    @Inject(MEDIA_REPOSITORY) private readonly media: MediaRepositoryPort,
    @Inject(USER_SENSOR_MUTE_REPOSITORY) private readonly mutes: UserSensorMuteRepositoryPort,
  ) {}

  async listEnabled(userId: number): Promise<readonly NotificationTarget[]> {
    const [sensors, cameras] = await Promise.all([this.sensors.listEnabled(), this.media.listCameras()]);
    const candidates = [
      ...sensors.map((sensor) => ({ ref: { kind: 'sensor' as const, id: sensor.id }, name: sensor.name })),
      ...cameras.filter((camera) => camera.enabled).map((camera) => ({ ref: { kind: 'camera' as const, id: camera.id }, name: camera.name })),
    ];
    const targets = await Promise.all(candidates.map(async ({ ref, name }) => ({
      ref, name, kind: ref.kind, muted: await this.mutes.isMuted(userId, ref),
    })));
    return targets.sort(compareTargets);
  }

  async findEnabled(ref: NotificationTargetRef, userId: number): Promise<NotificationTarget | null> {
    if (ref.kind === 'sensor') {
      const sensor = await this.sensors.findById(ref.id);
      return sensor ? this.withMute(userId, ref, sensor.name) : null;
    }
    const camera = (await this.media.listCameras()).find((candidate) => candidate.id === ref.id && candidate.enabled);
    return camera ? this.withMute(userId, ref, camera.name) : null;
  }

  async findEnabledByName(name: string, userId: number): Promise<NotificationTarget | null> {
    const lookup = await this.sensors.findByName(name);
    if (lookup?.kind === 'active') return this.withMute(userId, { kind: 'sensor', id: lookup.sensor.id }, lookup.sensor.name);
    const camera = await this.media.findCameraByName(name);
    return camera?.enabled ? this.withMute(userId, { kind: 'camera', id: camera.id }, camera.name) : null;
  }

  private async withMute(userId: number, ref: NotificationTargetRef, name: string): Promise<NotificationTarget> {
    return { ref, name, kind: ref.kind, muted: await this.mutes.isMuted(userId, ref) };
  }
}

export function notificationTargetPage(targets: readonly NotificationTarget[], requestedPage: number, pageSize = 8): NotificationTargetPage {
  const pageCount = Math.ceil(targets.length / pageSize);
  const page = pageCount === 0 ? 0 : Math.min(requestedPage, pageCount - 1);
  return { targets: targets.slice(page * pageSize, (page + 1) * pageSize), requestedPage, page, pageCount, total: targets.length, clamped: page !== requestedPage };
}

function compareTargets(left: NotificationTarget, right: NotificationTarget): number {
  const leftName = left.name.normalize('NFKC').toLowerCase();
  const rightName = right.name.normalize('NFKC').toLowerCase();
  if (leftName < rightName) return -1;
  if (leftName > rightName) return 1;
  if (left.kind < right.kind) return -1;
  if (left.kind > right.kind) return 1;
  return left.ref.id.localeCompare(right.ref.id);
}

import { Inject, Injectable } from '@nestjs/common';
import { SYSTEM_META_REPOSITORY, type SystemMetaRepositoryPort } from '../../system/domain/ports/system-meta-repository.port';
import {
  SENSOR_QUERY,
  type SensorQueryPort,
} from '../../sensors/domain/ports/sensor-query.port';
import type { HomeView } from '../domain/home-session';
import type { Role } from '../domain/role';
import { GetHomeSummaryUseCase } from './get-home-summary.use-case';
import { GetNotificationScreenUseCase } from './get-notification-screen.use-case';
import type { HomeScreen } from './home-screen';
import { NotificationTargetDirectoryService, notificationTargetPage } from './notification-target-directory.service';
import { NotificationTargetUnavailableError } from '../domain/errors/notification-target-unavailable.error';

export interface GetHomeScreenInput {
  userId: number;
  chatId: number;
  role: Role;
  view: HomeView;
}

@Injectable()
export class GetHomeScreenUseCase {
  constructor(
    private readonly summary: GetHomeSummaryUseCase,
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    private readonly notifications: GetNotificationScreenUseCase,
    private readonly targets: NotificationTargetDirectoryService,
    @Inject(SYSTEM_META_REPOSITORY) private readonly meta: SystemMetaRepositoryPort,
  ) {}

  async execute(input: GetHomeScreenInput): Promise<HomeScreen> {
    if (input.view.kind === 'home') {
      const summary = await this.summary.execute(input.userId);
      return { kind: 'home', summary, checking: input.view.checking };
    }
    if (input.view.kind === 'sensors') {
      const summary = await this.summary.execute(input.userId);
      const page = await this.sensors.listDashboardPage({ page: input.view.page, pageSize: 8 });
      return { kind: 'sensors', summary, page, checking: input.view.checking, isAdmin: input.role === 'admin' };
    }
    if (input.view.kind === 'notifications') return { kind: 'notifications', settings: await this.notifications.execute(input) };
    if (input.view.kind === 'notification-targets') {
      return { kind: 'notification-targets', page: notificationTargetPage(await this.targets.listEnabled(input.userId), input.view.page) };
    }
    if (input.view.kind === 'notification-target') {
      const target = await this.targets.findEnabled(input.view.target, input.userId);
      if (!target) throw new NotificationTargetUnavailableError(`${input.view.target.kind}:${input.view.target.id}`);
      return { kind: 'notification-target', target, page: input.view.page };
    }
    if (input.view.kind === 'pause-duration' || input.view.kind === 'history' || input.view.kind === 'admin-tools' || input.view.kind === 'admin-sensor-setup' || input.view.kind === 'admin-storage') return { kind: input.view.kind };
    if (input.view.kind === 'pause-confirmation') return { kind: input.view.kind, hours: input.view.hours, receiptId: input.view.receiptId };
    if (input.view.kind === 'more') return { kind: 'more', isAdmin: input.role === 'admin' };
    if (input.view.kind === 'admin-system') return { kind: 'admin-system', autoCleanThreshold: await this.autoCleanThreshold() };
    if (input.view.kind === 'confirmation') return { kind: 'confirmation', action: input.view.action, receiptId: input.view.receiptId };
    return { kind: 'cleanup-result', outcome: input.view.outcome, threshold: input.view.threshold };
  }

  private async autoCleanThreshold(): Promise<number> {
    const raw = await this.meta.get('auto_clean_threshold');
    const value = Number(raw);
    return Number.isFinite(value) && value >= 10 && value <= 99 ? Math.trunc(value) : 80;
  }
}

import { Inject, Injectable } from '@nestjs/common';
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
import { SetAutoCleanThresholdUseCase } from './set-auto-clean-threshold.use-case';
import { AdminHomeViewForbiddenError } from '../domain/errors/admin-home-view-forbidden.error';

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
    private readonly autoClean?: SetAutoCleanThresholdUseCase,
  ) {}

  async execute(input: GetHomeScreenInput): Promise<HomeScreen> {
    if (input.role !== 'admin' && isAdminHomeView(input.view)) {
      throw new AdminHomeViewForbiddenError(input.view);
    }
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
    if (input.view.kind === 'admin-system' || input.view.kind === 'admin-cleanup-threshold') {
      return { kind: 'admin-system', autoCleanThreshold: this.autoClean ? await this.autoClean.current() : 80 };
    }
    if (input.view.kind === 'confirmation') return { kind: 'confirmation', action: input.view.action, receiptId: input.view.receiptId };
    return { kind: 'cleanup-result', outcome: input.view.outcome, threshold: input.view.threshold };
  }
}

function isAdminHomeView(view: HomeView): boolean {
  switch (view.kind) {
    case 'admin-tools': case 'admin-sensor-setup': case 'admin-storage': case 'admin-system':
    case 'admin-cleanup-threshold': case 'confirmation': case 'cleanup-result':
      return true;
    default:
      return false;
  }
}

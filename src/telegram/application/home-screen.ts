import type { SensorDashboardPage } from '../../sensors/domain/sensor-dashboard-page';
import type { HomeView } from '../domain/home-session';
import type { HomeSummary } from './get-home-summary.use-case';
import type { NotificationScreen } from './get-notification-screen.use-case';
import type { NotificationTarget, NotificationTargetPage } from './notification-target-directory.service';

export type HomeScreen =
  | { kind: 'home'; summary: HomeSummary; checking: boolean }
  | {
    kind: 'sensors';
    summary: HomeSummary;
    page: SensorDashboardPage;
    checking: boolean;
    isAdmin: boolean;
  }
  | { kind: 'notifications'; settings: NotificationScreen }
  | { kind: 'notification-targets'; page: NotificationTargetPage }
  | { kind: 'notification-target'; target: NotificationTarget; page: number }
  | { kind: 'pause-duration' }
  | { kind: 'pause-confirmation'; hours: 1 | 4 | 8; receiptId: string }
  | { kind: 'history' }
  | { kind: 'more'; isAdmin: boolean }
  | { kind: 'admin-tools' }
  | { kind: 'admin-sensor-setup' }
  | { kind: 'admin-storage' }
  | { kind: 'admin-system'; autoCleanThreshold: number }
  | { kind: 'confirmation'; action: 'cleanup' | 'restart'; receiptId: string }
  | { kind: 'cleanup-result'; outcome: 'executed' | 'in-progress' | 'failed'; threshold: number | null };

/** Persists the page actually rendered, rather than the page originally requested. */
export function homeViewForScreen(screen: HomeScreen): HomeView {
  switch (screen.kind) {
    case 'home': return { kind: 'home', checking: screen.checking };
    case 'sensors': return { kind: 'sensors', page: screen.page.page, checking: screen.checking };
    case 'notification-targets': return { kind: 'notification-targets', page: screen.page.page, targets: screen.page.targets.map(({ ref }) => ref) };
    case 'notification-target': return { kind: 'notification-target', page: screen.page, target: screen.target.ref };
    case 'notifications': case 'pause-duration': case 'more': case 'history': case 'admin-tools': case 'admin-sensor-setup': case 'admin-storage': case 'admin-system': return { kind: screen.kind };
    case 'pause-confirmation': return { kind: screen.kind, hours: screen.hours, receiptId: screen.receiptId };
    case 'confirmation': return { kind: screen.kind, action: screen.action, receiptId: screen.receiptId };
    case 'cleanup-result': return { kind: screen.kind, outcome: screen.outcome, threshold: screen.threshold };
  }
}

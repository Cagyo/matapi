import type { SensorDashboardPage } from '../../sensors/domain/sensor-dashboard-page';
import type { HomeSummary } from './get-home-summary.use-case';

export type HomeScreen =
  | { kind: 'home'; summary: HomeSummary; checking: boolean }
  | {
    kind: 'sensors';
    summary: HomeSummary;
    page: SensorDashboardPage;
    checking: boolean;
    isAdmin: boolean;
  };

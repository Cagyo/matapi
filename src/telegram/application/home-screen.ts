import type { SensorDashboardPage } from '../../sensors/domain/sensor-dashboard-page';
import type { HomeView } from '../domain/home-session';
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

/** Persists the page actually rendered, rather than the page originally requested. */
export function homeViewForScreen(screen: HomeScreen): HomeView {
  return screen.kind === 'home'
    ? { kind: 'home', checking: screen.checking }
    : { kind: 'sensors', page: screen.page.page, checking: screen.checking };
}

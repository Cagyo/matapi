import { HomeHealthSnapshot } from '../../domain/home-health-snapshot';

export const HOME_HEALTH_SNAPSHOT = Symbol('HOME_HEALTH_SNAPSHOT');

export interface HomeHealthSnapshotPort {
  get(): HomeHealthSnapshot | null;
  set(snapshot: HomeHealthSnapshot): void;
}

import { Injectable } from '@nestjs/common';
import { HomeHealthSnapshotPort } from '../application/ports/home-health-snapshot.port';
import { HomeHealthSnapshot } from '../domain/home-health-snapshot';

@Injectable()
export class InMemoryHomeHealthSnapshotAdapter implements HomeHealthSnapshotPort {
  private snapshot: HomeHealthSnapshot | null = null;

  get(): HomeHealthSnapshot | null {
    return this.snapshot;
  }

  set(snapshot: HomeHealthSnapshot): void {
    Object.freeze(snapshot.enabledSensorIds);
    Object.freeze(snapshot.onlineSensorIds);
    Object.freeze(snapshot.missingSensorIds);
    Object.freeze(snapshot.failedSensorIds);
    Object.freeze(snapshot.timedOutSensorIds);
    Object.freeze(snapshot.offlineSensorIds);
    this.snapshot = Object.freeze(snapshot);
  }
}

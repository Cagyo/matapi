import { Injectable } from '@nestjs/common';
import { HomeHealthSnapshotPort } from '../application/ports/home-health-snapshot.port';
import { HomeHealthSnapshot } from '../domain/home-health-snapshot';

@Injectable()
export class InMemoryHomeHealthSnapshotAdapter implements HomeHealthSnapshotPort {
  private snapshot: HomeHealthSnapshot | null = null;

  get(): HomeHealthSnapshot | null {
    return this.snapshot ? this.clone(this.snapshot) : null;
  }

  set(snapshot: HomeHealthSnapshot): void {
    this.snapshot = this.clone(snapshot);
  }

  private clone(snapshot: HomeHealthSnapshot): HomeHealthSnapshot {
    return Object.freeze({
      completedAt: new Date(snapshot.completedAt.getTime()),
      enabledSensorIds: Object.freeze([...snapshot.enabledSensorIds]),
      onlineSensorIds: Object.freeze([...snapshot.onlineSensorIds]),
      missingSensorIds: Object.freeze([...snapshot.missingSensorIds]),
      failedSensorIds: Object.freeze([...snapshot.failedSensorIds]),
      timedOutSensorIds: Object.freeze([...snapshot.timedOutSensorIds]),
      offlineSensorIds: Object.freeze([...snapshot.offlineSensorIds]),
    });
  }
}

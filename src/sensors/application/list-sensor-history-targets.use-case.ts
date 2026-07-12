import { Inject, Injectable } from '@nestjs/common';
import {
  SENSOR_QUERY,
  SensorHistoryPage,
  SensorQueryPort,
} from '../domain/ports/sensor-query.port';

export interface ListSensorHistoryTargetsInput {
  page: number;
  pageSize: number;
}

@Injectable()
export class ListSensorHistoryTargetsUseCase {
  constructor(@Inject(SENSOR_QUERY) private readonly query: SensorQueryPort) {}

  async execute(input: ListSensorHistoryTargetsInput): Promise<SensorHistoryPage> {
    if (
      !Number.isInteger(input.page) ||
      input.page < 0 ||
      !Number.isInteger(input.pageSize) ||
      input.pageSize <= 0
    ) {
      throw new RangeError('Invalid pagination input');
    }

    return this.query.listHistoryTargets(input);
  }
}

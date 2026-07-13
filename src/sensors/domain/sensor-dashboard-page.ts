import { Sensor } from './sensor';
import { normalizedSensorName } from './sensor-state-classifier';

export interface SensorDashboardPage {
  sensors: readonly Sensor[];
  requestedPage: number;
  page: number;
  pageCount: number;
  total: number;
  clamped: boolean;
}

export function buildSensorDashboardPage(
  sensors: readonly Sensor[],
  input: { page: number; pageSize: number },
): SensorDashboardPage {
  const ordered = [...sensors].sort(compareSensors);
  const requestedPage = input.page;
  const pageCount = Math.ceil(ordered.length / input.pageSize);
  const page = pageCount === 0
    ? 0
    : Math.min(Math.max(requestedPage, 0), pageCount - 1);
  const start = page * input.pageSize;

  return {
    sensors: pageCount === 0 ? [] : ordered.slice(start, start + input.pageSize),
    requestedPage,
    page,
    pageCount,
    total: ordered.length,
    clamped: requestedPage !== page,
  };
}

function compareSensors(left: Sensor, right: Sensor): number {
  const leftName = normalizedSensorName(left.name);
  const rightName = normalizedSensorName(right.name);
  if (leftName < rightName) return -1;
  if (leftName > rightName) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

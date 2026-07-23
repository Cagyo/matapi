import type { ManageableFeatureName } from '../../features/domain/manageable-feature';
import type { SensorType } from '../domain/sensor';

/** Maps sensor runtimes to the feature that authorizes them. */
export function featureForSensorType(type: SensorType): ManageableFeatureName | null {
  if (type === 'digital') return 'digital';
  if (type === 'uart') return 'uart';
  if (type === 'mqtt') return 'zigbee';
  return null;
}

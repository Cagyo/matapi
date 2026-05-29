import { SensorSeverity, SensorType } from '../../sensors/domain/sensor';

const TYPE_ICONS: Record<SensorType, string> = {
  digital: '🚪',
  uart: '🌬️',
  mqtt: '📡',
  camera: '📷',
};

/** Inputs needed to render a single sensor-event notification (spec 19). */
export interface SensorNotificationView {
  /** Sensor type drives the leading icon; `null` falls back to a bullet. */
  type: SensorType | null;
  name: string;
  /** Raw new value from the event payload (boolean, number, string, …). */
  value: unknown;
  severity: SensorSeverity;
}

/**
 * Pure formatter for an immediate, per-user sensor notification (spec 19):
 *   `🚪 front_door: OPENED`
 *   `💧 water_kitchen: TRIGGERED ⚠️`
 *   `🌬️ co2_living: 950 ppm ⚠️`
 * Warning/critical severity append a ⚠️ marker.
 */
export function formatSensorNotification(view: SensorNotificationView): string {
  const icon = view.type ? TYPE_ICONS[view.type] : '•';
  const value = formatValue(view.type, view.value);
  const marker =
    view.severity === 'warning' || view.severity === 'critical' ? ' ⚠️' : '';
  return `${icon} ${view.name}: ${value}${marker}`;
}

function formatValue(type: SensorType | null, value: unknown): string {
  if (type === 'digital') {
    if (value === true || value === 'true' || value === '1') return 'OPENED';
    if (value === false || value === 'false' || value === '0') return 'CLOSED';
  }
  if (type === 'uart' && (typeof value === 'number' || isNumericString(value))) {
    return `${value} ppm`;
  }
  return String(value);
}

function isNumericString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value));
}

// Re-export the canonical SensorEvent shape owned by the sensors context.
// The `events` context consumes sensor events through `SensorEventSourcePort`;
// the type lives with its producer to avoid duplicated definitions.
export {
  SensorEvent,
  SensorEventType,
} from '../../sensors/domain/sensor-event';
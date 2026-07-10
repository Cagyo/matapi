import { isValidSensorName } from './errors/invalid-sensor-name.error';
import { DIGITAL_STEP_TYPES, isDigitalStepType, SensorSeverity, SensorType } from './sensor';
import { defaultDebounceMs } from './default-debounce';
import {
  cameraConfigIssues,
  mqttConfigIssues,
} from './sensor-type-config-validation';

/** Standard baud rates accepted for UART sensors (spec 16 § Validation). */
export const ALLOWED_BAUD_RATES = [9600, 19200, 38400, 57600, 115200] as const;

const SENSOR_TYPES: readonly SensorType[] = ['digital', 'uart', 'mqtt', 'camera'];
const SEVERITIES: readonly SensorSeverity[] = ['info', 'warning', 'critical'];

/** A sensor entry parsed + validated from an imported config (spec 16). */
export interface ImportedSensor {
  name: string;
  type: SensorType;
  config: Record<string, unknown>;
  debounceMs: number;
  severity: SensorSeverity;
}

export type ImportValidation =
  | { ok: true; sensors: ImportedSensor[] }
  | { ok: false; errors: string[] };

/**
 * Validate the raw, parsed YAML of an imported config (spec 16 § Validation
 * Rules). Pure — no I/O. Only the `sensors` section is validated; cameras and
 * features are export-only. Returns the normalized sensor list on success, or
 * the full list of human-readable errors on failure.
 */
export function validateImportConfig(raw: unknown): ImportValidation {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: ["Config root must be a YAML mapping"] };
  }

  const rawSensors = raw.sensors;
  if (!Array.isArray(rawSensors)) {
    return {
      ok: false,
      errors: ["Missing or invalid 'sensors' list"],
    };
  }

  const sensors: ImportedSensor[] = [];
  const seenNames = new Set<string>();
  const pinOwners = new Map<number, string>();

  rawSensors.forEach((entry, index) => {
    const label = entryLabel(entry, index);

    if (!isRecord(entry)) {
      errors.push(`Sensor ${label}: must be a mapping`);
      return;
    }

    const name = entry.name;
    let validName = false;
    if (typeof name !== 'string' || name.length === 0) {
      errors.push(`Sensor ${label}: missing required field 'name'`);
    } else if (!isValidSensorName(name)) {
      errors.push(
        `Sensor '${name}': invalid name (use alphanumerics and underscores only)`,
      );
    } else {
      validName = true;
      if (seenNames.has(name)) {
        errors.push(`Sensor '${name}': duplicate name`);
      }
      seenNames.add(name);
    }

    const type = entry.type;
    const validType =
      typeof type === 'string' && SENSOR_TYPES.includes(type as SensorType);
    if (!validType) {
      errors.push(
        `Sensor ${label}: invalid type '${String(type)}' (expected ${SENSOR_TYPES.join(', ')})`,
      );
    }

    const config = entry.config;
    if (!isRecord(config)) {
      errors.push(`Sensor ${label}: missing required field 'config'`);
    } else if (validType) {
      validateTypeConfig(type as SensorType, config, label, errors, pinOwners);
    }

    const severity = entry.severity;
    let resolvedSeverity: SensorSeverity = 'info';
    if (severity !== undefined) {
      if (
        typeof severity !== 'string' ||
        !SEVERITIES.includes(severity as SensorSeverity)
      ) {
        errors.push(
          `Sensor ${label}: invalid severity '${display(severity)}' (expected ${SEVERITIES.join(', ')})`,
        );
      } else {
        resolvedSeverity = severity as SensorSeverity;
      }
    }

    const debounceRaw = entry.debounce_ms;
    let resolvedDebounce = validType
      ? defaultDebounceMs(type as SensorType)
      : 10_000;
    if (debounceRaw !== undefined) {
      if (!isNonNegativeInteger(debounceRaw)) {
        errors.push(
          `Sensor ${label}: invalid debounce_ms '${display(debounceRaw)}' (must be a non-negative integer)`,
        );
      } else {
        resolvedDebounce = debounceRaw;
      }
    }

    if (validName && validType && isRecord(config)) {
      sensors.push({
        name: name as string,
        type: type as SensorType,
        config: config,
        debounceMs: resolvedDebounce,
        severity: resolvedSeverity,
      });
    }
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, sensors };
}

function validateTypeConfig(
  type: SensorType,
  config: Record<string, unknown>,
  label: string,
  errors: string[],
  pinOwners: Map<number, string>,
): void {
  if (type === 'digital') {
    const pin = config.pin;
    if (!isInteger(pin) || pin < 0 || pin > 27) {
      errors.push(
        `Sensor ${label}: invalid pin number ${String(pin)} (must be 0-27)`,
      );
      return;
    }
    const owner = pinOwners.get(pin);
    if (owner !== undefined) {
      errors.push(
        `Sensors ${owner} and ${label} both use GPIO pin ${pin}`,
      );
    } else {
      pinOwners.set(pin, label);
    }
    const stepType = config.stepType;
    if (stepType !== undefined && !isDigitalStepType(stepType)) {
      errors.push(
        `Sensor ${label}: invalid stepType '${JSON.stringify(stepType)}' (expected ${DIGITAL_STEP_TYPES.join(', ')})`,
      );
    }
    const invert = config.invert;
    if (invert !== undefined && typeof invert !== 'boolean') {
      errors.push(`Sensor ${label}: invert must be a boolean`);
    }
    const activeLow = config.activeLow;
    if (activeLow !== undefined && typeof activeLow !== 'boolean') {
      errors.push(`Sensor ${label}: activeLow must be a boolean`);
    }
    return;
  }

  if (type === 'uart') {
    const port = config.port;
    if (typeof port !== 'string' || port.length === 0) {
      errors.push(`Sensor ${label}: missing required field 'port'`);
    }
    const baud = config.baudRate;
    if (
      !isInteger(baud) ||
      !ALLOWED_BAUD_RATES.includes(baud as (typeof ALLOWED_BAUD_RATES)[number])
    ) {
      errors.push(
        `Sensor ${label}: invalid baudRate '${String(baud)}' (expected ${ALLOWED_BAUD_RATES.join(', ')})`,
      );
    }
    const thresholds = config.thresholds;
    if (!isRecord(thresholds)) {
      errors.push(`Sensor ${label}: missing required field 'thresholds'`);
      return;
    }
    const warning = thresholds.warning;
    const critical = thresholds.critical;
    if (typeof warning !== 'number' || typeof critical !== 'number') {
      errors.push(`Sensor ${label}: thresholds.warning and thresholds.critical must be numbers`);
      return;
    }
    if (warning >= critical) {
      errors.push(`Sensor ${label}: thresholds.warning must be less than thresholds.critical`);
    }
    return;
  }

  const issues =
    type === 'mqtt' ? mqttConfigIssues(config) : cameraConfigIssues(config);
  for (const issue of issues) {
    errors.push(`Sensor ${label}: ${issue}`);
  }
}

function entryLabel(entry: unknown, index: number): string {
  if (isRecord(entry) && typeof entry.name === 'string' && entry.name.length) {
    return `'${entry.name}'`;
  }
  return `#${index + 1}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

/** Render an arbitrary value for error messages without `[object Object]`. */
function display(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

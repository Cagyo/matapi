const MQTT_FORMATS = ['zigbee2mqtt', 'tasmota', 'json', 'auto'] as const;
const CAMERA_TYPES = ['rtsp', 'mjpeg', 'usb', 'libcamera'] as const;

/**
 * Returns all MQTT sensor-config shape violations without normalizing values
 * or accessing runtime configuration.
 */
export function mqttConfigIssues(raw: Record<string, unknown>): string[] {
  const issues: string[] = [];

  if (typeof raw.topic !== 'string' || raw.topic.trim().length === 0) {
    issues.push('missing required string property "topic"');
  }

  if (raw.qos !== undefined && raw.qos !== 0 && raw.qos !== 1 && raw.qos !== 2) {
    issues.push(`invalid "qos": ${render(raw.qos)}`);
  }

  if (raw.format !== undefined && !MQTT_FORMATS.includes(raw.format as (typeof MQTT_FORMATS)[number])) {
    issues.push(`invalid "format": ${render(raw.format)}`);
  }

  if (raw.reconnectMs !== undefined && !isNonNegativeInteger(raw.reconnectMs)) {
    issues.push(`invalid "reconnectMs": ${render(raw.reconnectMs)}`);
  }

  return issues;
}

/**
 * Returns all camera sensor-config shape violations without normalizing values
 * or accessing runtime configuration.
 */
export function cameraConfigIssues(raw: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const type = raw.type;

  if (!CAMERA_TYPES.includes(type as (typeof CAMERA_TYPES)[number])) {
    issues.push(`invalid camera "type": ${render(type)}`);
  } else if (
    (type === 'rtsp' || type === 'mjpeg') &&
    (typeof raw.url !== 'string' || raw.url.trim().length === 0)
  ) {
    issues.push(`camera type "${type}" requires a valid string "url"`);
  }

  if (
    raw.snapshotCacheTtlMs !== undefined &&
    !isNonNegativeInteger(raw.snapshotCacheTtlMs)
  ) {
    issues.push(`invalid "snapshotCacheTtlMs": ${render(raw.snapshotCacheTtlMs)}`);
  }

  if (raw.resolution !== undefined) {
    if (!isRecord(raw.resolution)) {
      issues.push(`invalid "resolution": ${render(raw.resolution)}`);
    } else {
      if (
        raw.resolution.width !== undefined &&
        !isPositiveInteger(raw.resolution.width)
      ) {
        issues.push(`invalid "resolution.width": ${render(raw.resolution.width)}`);
      }
      if (
        raw.resolution.height !== undefined &&
        !isPositiveInteger(raw.resolution.height)
      ) {
        issues.push(`invalid "resolution.height": ${render(raw.resolution.height)}`);
      }
    }
  }

  return issues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function render(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return String(value);
  }
  if (value === undefined) {
    return 'undefined';
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized ?? `[${typeof value}]`;
  } catch {
    return '[unserializable value]';
  }
}

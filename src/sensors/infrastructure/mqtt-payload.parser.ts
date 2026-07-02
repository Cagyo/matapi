export interface ParsedPayload {
  value: string | number | boolean;
  raw: Record<string, unknown>;
}

/**
 * Extracts a value from an object given a dot-delimited key path (e.g. "ENERGY.Power" or "occupancy").
 */
function extractByKey(obj: Record<string, unknown>, keyPath: string): unknown {
  const parts = keyPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function isPrimitive(val: unknown): val is string | number | boolean {
  return typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean';
}

function parsePrimitiveString(str: string): string | number | boolean {
  const trimmed = str.trim();
  if (trimmed.toLowerCase() === 'true' || trimmed.toUpperCase() === 'ON') return true;
  if (trimmed.toLowerCase() === 'false' || trimmed.toUpperCase() === 'OFF') return false;
  const num = Number(trimmed);
  if (trimmed !== '' && !isNaN(num)) {
    return num;
  }
  return trimmed;
}

function parseZigbee2Mqtt(json: Record<string, unknown>, valueKey?: string): ParsedPayload | null {
  if (valueKey) {
    const val = extractByKey(json, valueKey);
    if (isPrimitive(val)) {
      return { value: val, raw: json };
    }
  }
  const commonKeys = ['occupancy', 'contact', 'temperature', 'humidity', 'illuminance', 'state', 'battery', 'power'];
  for (const key of commonKeys) {
    if (key in json && isPrimitive(json[key])) {
      let val = json[key];
      if (typeof val === 'string') {
        const upper = val.toUpperCase();
        if (upper === 'ON') val = true;
        else if (upper === 'OFF') val = false;
      }
      return { value: val, raw: json };
    }
  }
  return null;
}

function parseTasmota(json: Record<string, unknown>, valueKey?: string): ParsedPayload | null {
  if (valueKey) {
    const val = extractByKey(json, valueKey);
    if (isPrimitive(val)) {
      return { value: val, raw: json };
    }
  }
  const sensorContainers = ['ENERGY', 'AM2301', 'DS18B20', 'HTU21', 'BME280', 'BMP280'];
  for (const containerKey of sensorContainers) {
    if (containerKey in json && typeof json[containerKey] === 'object' && json[containerKey] !== null) {
      const sub = json[containerKey] as Record<string, unknown>;
      const metricKeys = ['Power', 'Temperature', 'Humidity', 'Total'];
      for (const mKey of metricKeys) {
        if (mKey in sub && isPrimitive(sub[mKey])) {
          return { value: sub[mKey] as string | number | boolean, raw: json };
        }
      }
    }
  }
  return null;
}

function parseGenericJson(json: Record<string, unknown>, valueKey?: string): ParsedPayload | null {
  if (valueKey) {
    const val = extractByKey(json, valueKey);
    if (isPrimitive(val)) {
      return { value: val, raw: json };
    }
  }
  for (const key of Object.keys(json)) {
    if (isPrimitive(json[key])) {
      return { value: json[key] as string | number | boolean, raw: json };
    }
  }
  return null;
}

export function parseMqttPayload(
  buffer: Buffer,
  format: 'zigbee2mqtt' | 'tasmota' | 'json' | 'auto',
  valueKey?: string,
): ParsedPayload | null {
  try {
    const rawString = buffer.toString('utf8').trim();
    if (!rawString) return null;

    if (rawString.startsWith('{') || rawString.startsWith('[')) {
      try {
        const parsed = JSON.parse(rawString);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const jsonObj = parsed as Record<string, unknown>;
          if (format === 'zigbee2mqtt') {
            return parseZigbee2Mqtt(jsonObj, valueKey) || parseGenericJson(jsonObj, valueKey);
          }
          if (format === 'tasmota') {
            return parseTasmota(jsonObj, valueKey) || parseGenericJson(jsonObj, valueKey);
          }
          if (format === 'json') {
            return parseGenericJson(jsonObj, valueKey);
          }
          if (format === 'auto') {
            const z2m = parseZigbee2Mqtt(jsonObj, valueKey);
            if (z2m) return z2m;
            const tas = parseTasmota(jsonObj, valueKey);
            if (tas) return tas;
            const gen = parseGenericJson(jsonObj, valueKey);
            if (gen) return gen;
          }
        }
      } catch {
        // Not valid JSON despite starting with { or [, fall back to plain text
      }
    }

    // Fall back to plain text parsing
    const val = parsePrimitiveString(rawString);
    return {
      value: val,
      raw: { rawString },
    };
  } catch {
    return null;
  }
}

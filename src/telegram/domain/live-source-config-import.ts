import type { ConfigSnapshotLiveSource } from './config-snapshot';

export type LiveSourceConfigValidation =
  | { ok: true; liveSources: ConfigSnapshotLiveSource[] }
  | { ok: false; errors: string[] };

const ALLOWED_KEYS = new Set([
  'camera_name',
  'scheme',
  'host',
  'transport',
  'tls_mode',
  'profile',
  'substream_host',
  'ready',
]);

export function validateLiveSourceConfig(raw: unknown): LiveSourceConfigValidation {
  if (raw === undefined) return { ok: true, liveSources: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, errors: ["Missing or invalid 'live_sources' list"] };
  }
  const errors: string[] = [];
  const liveSources: ConfigSnapshotLiveSource[] = [];
  const names = new Set<string>();
  raw.forEach((value, index) => {
    if (!isRecord(value)) {
      errors.push(`Live source #${index + 1}: must be a mapping`);
      return;
    }
    const label = typeof value.camera_name === 'string'
      ? `'${value.camera_name}'`
      : `#${index + 1}`;
    if (Object.keys(value).some((key) => !ALLOWED_KEYS.has(key))) {
      errors.push(`Live source ${label}: contains an unsupported field`);
      return;
    }
    const scheme = value.scheme;
    const tlsMode = value.tls_mode;
    const valid =
      typeof value.camera_name === 'string' && value.camera_name.length > 0 &&
      typeof value.host === 'string' && value.host.length > 0 &&
      (scheme === 'rtsp' || scheme === 'rtsps') &&
      (value.transport === 'auto' || value.transport === 'tcp' || value.transport === 'udp') &&
      (value.profile === 'eco' || value.profile === 'balanced' || value.profile === 'quality') &&
      value.ready === false &&
      ((scheme === 'rtsp' && tlsMode === 'none') ||
        (scheme === 'rtsps' && tlsMode === 'strict')) &&
      (value.substream_host === undefined || value.substream_host === null ||
        (typeof value.substream_host === 'string' && value.substream_host.length > 0));
    if (!valid) {
      errors.push(`Live source ${label}: metadata is invalid`);
      return;
    }
    if (names.has(value.camera_name as string)) {
      errors.push(`Live source ${label}: duplicate camera name`);
      return;
    }
    names.add(value.camera_name as string);
    liveSources.push(value as unknown as ConfigSnapshotLiveSource);
  });
  return errors.length ? { ok: false, errors } : { ok: true, liveSources };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

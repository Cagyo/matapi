import { QueuedEvent } from './queued-event.entity';

type Severity = 'info' | 'warning' | 'critical';

/**
 * Pure aggregator for queued events. Per spec 05:
 *  - single event → one line.
 *  - multiple events → `📋 Offline events (start — end):` header + chronological body.
 *  - warning/critical events suffixed with ⚠️.
 *  - sensor name preferred over id when stored in the payload.
 */
export function summarizeEvents(batch: readonly QueuedEvent[]): string {
  if (batch.length === 0) return '';
  if (batch.length === 1) return formatLine(batch[0]);

  const range = computeRange(batch);
  const body = batch.map(formatLine).join('\n');
  return `📋 Offline events (${range}):\n\n${body}`;
}

function formatLine(event: QueuedEvent): string {
  const time = formatEventTime(event.createdAt);
  const subject = sensorName(event) ?? event.sensorId ?? 'system';
  const description = describeEvent(event);
  const marker = severityMarker(event);
  return `${time} — ${subject} ${description}${marker}`;
}

function describeEvent(event: QueuedEvent): string {
  const payload = event.payload;
  if (event.type === 'state_change' && payload && 'newValue' in payload) {
    return String(payload.newValue);
  }
  return event.type;
}

function sensorName(event: QueuedEvent): string | null {
  const payload = event.payload;
  const value = payload?.name;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function severityMarker(event: QueuedEvent): string {
  const payload = event.payload;
  const severity = payload?.severity as Severity | undefined;
  if (severity === 'warning' || severity === 'critical') return ' ⚠️';
  return '';
}

function computeRange(batch: readonly QueuedEvent[]): string {
  const times = batch
    .map((event) => event.createdAt)
    .filter((d): d is Date => d !== null)
    .map((d) => d.getTime());
  if (times.length === 0) return '—';
  const start = new Date(Math.min(...times));
  const end = new Date(Math.max(...times));
  return start.getTime() === end.getTime()
    ? start.toISOString()
    : `${start.toISOString()} — ${end.toISOString()}`;
}

function formatEventTime(date: Date | null): string {
  return date ? date.toISOString() : '—';
}

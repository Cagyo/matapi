import { QueuedEvent } from './queued-event.entity';

export function summarizeEvents(batch: readonly QueuedEvent[]): string {
  if (batch.length === 1) {
    const event = batch[0];
    return `${formatEventTime(event.createdAt)} — ${event.sensorId ?? 'system'} ${event.type}`;
  }

  const lines = batch.map(
    (event) => `${formatEventTime(event.createdAt)} — ${event.sensorId ?? 'system'} ${event.type}`,
  );
  return `📋 Events (${batch.length}):\n\n${lines.join('\n')}`;
}

function formatEventTime(date: Date | null): string {
  return date ? date.toISOString() : '—';
}
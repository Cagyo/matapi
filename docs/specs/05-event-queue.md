# 05 — Event Queue

## Dependencies
- 01-database.md (events table)
- 06-bot-core.md (grammY bot instance for sending)

## Delivery Guarantee

**At-least-once delivery.** An event is marked sent only after Telegram API returns HTTP 200. If connection drops after Telegram receives the message but before `sent_at` is written to SQLite, the event is re-sent. Duplicates are acceptable; lost notifications are not.

## Write Flow

All sensor events written to `events` table with `sent_at = NULL`. EventProcessor attempts immediate send. On failure (no internet), event remains queued indefinitely.

## Queue Drain on Reconnect

```typescript
async drainQueue() {
  while (true) {
    const batch = db.select().from(events)
      .where(isNull(events.sentAt))
      .orderBy(events.createdAt)
      .limit(50);

    if (batch.length === 0) break;

    const summary = this.aggregateBatch(batch);
    await this.sendToTelegram(summary);
    this.markAsSent(batch);

    await sleep(2000); // respect Telegram rate limits
  }
}
```

## Aggregated Summaries

Offline events sent as chronological summaries preserving causal order:

```
📋 Offline events (05.04.2026 14:00 — 08.04.2026 09:30):

05.04.2026 14:23 — door_1 OPENED
05.04.2026 14:24 — water_1 TRIGGERED ⚠️
05.04.2026 14:25 — door_1 CLOSED
06.04.2026 08:00 — CO2 peak 1450ppm
... (12 more events)
```

- Critical events highlighted with ⚠️
- If summary exceeds 4096 chars: split into multiple messages or send as file

## Force Aggregation

If unsent queue exceeds 100 events (`max_queue_before_force_aggregate`):
- Aggregate entire backlog into a single summary file
- Send as Telegram document attachment
- Mark all as sent
- Prevents hours-long drip-feed after extended outages

## Network Flapping

WiFi drops and reconnects repeatedly. Drain starts, connection drops mid-drain. Because `sent_at` is set per-batch after successful Telegram delivery, partially-sent batches are safe. The batch either fully succeeds or fully retries.

## Connection to Notifications

The event queue is the write side. Notifications (19-bot-notifications.md) consume events and apply debounce, mute, and quiet hours logic before sending. The queue itself stores raw events without filtering.

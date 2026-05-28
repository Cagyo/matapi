# 05 — Event Queue

## Dependencies
- 01-database.md (events table)
- ../ports-and-adapters.md (`EventRepositoryPort`, `NotifierPort`, `ClockPort`)

This spec is a pure application-layer concern. It depends on **ports**, never on the grammY bot directly — the bot is one of many possible adapters behind `NotifierPort`.

## Delivery Guarantee

**At-least-once delivery.** An event is marked sent only after Telegram API returns HTTP 200. If connection drops after Telegram receives the message but before `sent_at` is written to SQLite, the event is re-sent. Duplicates are acceptable; lost notifications are not.

## Write Flow

All sensor events written to `events` table with `sent_at = NULL`. EventProcessor attempts immediate send. On failure (no internet), event remains queued indefinitely.

## Queue Drain on Reconnect

Lives in `src/events/application/drain-event-queue.use-case.ts`. Depends only on ports — **no Drizzle imports, no grammY imports**.

```typescript
@Injectable()
export class DrainEventQueueUseCase {
  constructor(
    @Inject(EVENT_REPOSITORY) private readonly repo: EventRepositoryPort,
    @Inject(NOTIFIER)         private readonly notifier: NotifierPort,
    @Inject(CLOCK)            private readonly clock: ClockPort,
  ) {}

  async execute(): Promise<void> {
    while (true) {
      const batch = await this.repo.pending(50);
      if (batch.length === 0) break;

      const summary = aggregate(batch);                // pure domain fn
      await this.notifier.notify(summary);
      await this.repo.markSent(batch.map(b => b.id), this.clock.now());

      // Inter-batch pacing for Telegram rate limits is the notifier adapter's
      // concern (auto-retry plugin), not this use case. Do not sleep() here.
    }
  }
}
```

Note: `aggregate(...)` is a pure function in `events/domain/` — testable without Nest. The 2-second pacing in the legacy sketch belongs in the `TelegramNotifierAdapter` (or comes for free via `@grammyjs/auto-retry`), not the use case.

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

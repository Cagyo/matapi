# Camera File Browser Design

Date: 2026-07-09

## Summary

Add a Telegram file-browser flow inside the existing camera dashboard. The
browser lets registered users find recorded Motion events from database records,
select an event, then upload either the video or its thumbnail to Telegram.

The feature extends the current `/camera` dashboard instead of replacing
existing commands. Existing `/camera events`, `/camera video <id>`, and
`/camera photo <id>` behavior remains available.

## User Flow

1. User opens `/camera` or selects Camera from `/menu`.
2. Camera dashboard shows `Snapshot`, `Browse Files`, `Today's Events`,
   `Status`, and `Close`.
3. `Browse Files` shows date-source buttons:
   - `Today`
   - `Yesterday`
   - `Pick date`
   - `Latest 20`
4. `Today`, `Yesterday`, and `Pick date` continue into a required typed time
   range prompt: `HH:MM-HH:MM`.
5. `Pick date` first asks for a typed date in `DD.MM.YYYY`, then asks for the
   time range.
6. A valid date/time search lists up to 20 newest matching motion events.
7. `Latest 20` bypasses date/time input and lists the newest 20 motion events
   overall.
8. Event buttons use compact labels built from available data, for example:
   `12:51 | #42 | 30s | front_door`. The camera segment may be a camera name
   or id, depending on what the event row can provide.
9. Selecting an event opens an action screen.
10. The action screen always shows `Video`; it shows `Thumbnail` only when the
    event has `snapshotPath`.
11. Selecting `Video` or `Thumbnail` uploads the selected media to Telegram.

## Architecture

The feature stays within existing context boundaries.

- `telegram/interfaces/CameraHandler` owns the inline keyboard flow, per-user
  pending input state, callback parsing, and Telegram uploads.
- `camera/application` gets a small browse read use case over
  `MediaRepositoryPort`.
- `camera/domain/ports/MediaRepositoryPort` is extended with browse-oriented
  query methods.
- `camera/infrastructure/DrizzleMediaRepository` and
  `InMemoryMediaRepository` implement the new query methods.
- `src/locales/en.ts` owns all new user-facing strings and event-label
  formatting.

Telegram does not scan `/home/pi/motion/videos` directly. Browsing uses
`motion_events` rows so video paths, thumbnail paths, timestamps, event ids, and
Drive fallback state remain connected.

## Data Queries

The browse use case supports two query modes:

- Latest events: newest-first, capped at 20.
- Date/time range: events where `startedAt` is inside the selected local date
  and typed range, newest-first, capped at 20.

The time range format is exactly `HH:MM-HH:MM`.

Rules:

- Hours are `00` through `23`.
- Minutes are `00` through `59`.
- The end time must be after the start time.
- Overnight ranges such as `23:00-01:00` are rejected in the first version.
- Search uses local-time `Date` construction, matching existing
  `listEventsOnDay` behavior.

## Telegram State

The handler keeps minimal in-memory pending state per Telegram user:

- Awaiting typed date after `Pick date`.
- Awaiting typed time range after a date has been selected.

Invalid typed input replies with a concise format error and keeps the user in
the same step. The flow can be restarted at any time by pressing `Browse Files`
again or by opening `/camera`.

Callback data uses the existing `cam:` namespace with new browse-specific
actions, for example:

- `cam:browse`
- `cam:browse:today`
- `cam:browse:yesterday`
- `cam:browse:pick-date`
- `cam:browse:latest`
- `cam:browse:event:<id>`
- `cam:browse:video:<id>`
- `cam:browse:thumb:<id>`

## Delivery

Video delivery reuses `GetMotionVideoUseCase`.

- If a local video is available and acceptable for Telegram, upload it using
  grammY `InputFile`.
- If the local video is unavailable or too large but a Drive copy exists, keep
  the existing Drive fallback message.
- If no copy is available, show the existing unavailable media response.

Thumbnail delivery reuses `GetMotionPhotoUseCase`.

- The `Thumbnail` button is hidden when `snapshotPath` is absent.
- If the thumbnail disappears between listing and upload, show the existing
  snapshot/media unavailable response.

## Error Handling

Expected user input errors:

- Invalid date: ask for `DD.MM.YYYY`.
- Invalid time range: ask for `HH:MM-HH:MM`.
- Overnight or zero-length range: explain that the end time must be after the
  start time.
- No matching events: show a concise empty-state message for the selected
  date/time or latest query.

Domain errors from existing media use cases continue to be mapped at the
Telegram interface boundary.

## Testing

Add focused tests for:

- Browse use case latest-event ordering and limit.
- Browse use case date/time filtering and invalid ranges.
- Drizzle repository newest-first browse queries.
- In-memory repository browse queries.
- Camera handler browse callbacks and pending typed input transitions.
- Event action keyboard hiding `Thumbnail` when no snapshot exists.
- Locale event-label and validation-message formatting.

## Out of Scope

- Raw filesystem browsing outside the `motion_events` database.
- Pagination beyond the newest 20 events.
- Overnight time ranges.
- New top-level `/camera browse` command.
- Replacing current `/camera events` output.

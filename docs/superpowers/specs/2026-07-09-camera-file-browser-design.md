# Camera Event Browser Design

Date: 2026-07-09

## Summary

Add a Telegram event-browser flow inside the existing `/camera` dashboard. The
flow lets registered users find recorded Motion events from database records,
select one event, then request its video or saved photo through Telegram.

The browser is an exact-search tool. `Today`, `Yesterday`, and `Pick date` all
lead to a typed time-range prompt, while `Latest 20` remains the fast escape
hatch for recent activity. Existing `/camera events`, `/camera video <id>`, and
`/camera photo <id>` commands remain available.

## Product Intent

- Keep camera retrieval button-led for mobile Telegram users.
- Keep exact date/time search central so users can narrow noisy motion history.
- Give typed prompts enough examples and recovery controls to avoid dead ends.
- Browse `motion_events` rows, not raw files, so timestamps, ids, media paths,
  deletion state, and Drive fallback stay connected.

## Terminology

- Use `Browse Events`, not `Browse Files`. Users are choosing motion events from
  the database, not navigating a filesystem.
- Use `Photo`, not `Thumbnail`, in Telegram copy. It matches the existing
  `/camera photo <id>` command and is clearer to non-technical users.
- Use `Latest 20` for the newest event shortcut. It bypasses typed input.
- Use `time range` for the exact `HH:MM-HH:MM` input.

## Screen Contracts

All user-facing strings live in `src/locales/en.ts`. Message examples below are
the intended English copy; implementation can keep the existing emoji style and
plain text formatting.

### 1. Camera Dashboard

Entry points:

- `/camera`
- `/camera menu`
- `/camera dashboard`
- Camera button from `/menu`

Message:

```text
📹 Camera Dashboard
Select an action:
```

Keyboard:

```text
[📸 Take Snapshot] [📹 Browse Events]
[📹 Today's Events] [⚙️ Status]
[❌ Close]
```

Callback mapping:

- `📸 Take Snapshot` -> `cam:snapshot`
- `📹 Browse Events` -> `cam:browse`
- `📹 Today's Events` -> existing `cam:events`
- `⚙️ Status` -> `cam:status`
- `❌ Close` -> `cam:close`

`Today's Events` remains the existing quick daily summary. `Browse Events` is
the exact-search flow.

### 2. Browse Events Menu

Shown after `cam:browse`.

Message:

```text
📹 Browse Motion Events
Choose a search mode.

Today, Yesterday, and Pick date will ask for a time range next.
```

Keyboard:

```text
[Today] [Yesterday]
[Pick date] [Latest 20]
[Back] [Close]
```

Callback mapping:

- `Today` -> `cam:browse:today`
- `Yesterday` -> `cam:browse:yesterday`
- `Pick date` -> `cam:browse:pick-date`
- `Latest 20` -> `cam:browse:latest`
- `Back` -> camera dashboard
- `Close` -> remove keyboard and reply with the existing camera closed message

### 3. Date Prompt

Shown after `Pick date`.

Message:

```text
Send the date to search.

Format: DD.MM.YYYY
Example: 08.04.2026
```

Keyboard:

```text
[Back] [Cancel]
```

Behavior:

- Store pending input state `awaiting-date`.
- A valid date advances to the time-range prompt.
- `Back` returns to Browse Events and clears pending input.
- `Cancel` clears pending input and replies with the cancellation message.

Invalid date reply:

```text
Date needs to be DD.MM.YYYY.
Example: 08.04.2026
```

The user remains in `awaiting-date`.

### 4. Time-Range Prompt

Shown after `Today`, `Yesterday`, or a valid picked date.

Message for Today:

```text
Send the time range for today.

Format: HH:MM-HH:MM
Example: 18:00-23:00
```

Message for Yesterday:

```text
Send the time range for yesterday.

Format: HH:MM-HH:MM
Example: 18:00-23:00
```

Message for a picked date:

```text
Send the time range for 08.04.2026.

Format: HH:MM-HH:MM
Example: 18:00-23:00
```

Keyboard:

```text
[Back] [Cancel]
```

Behavior:

- Store pending input state `awaiting-range` with the selected local date and a
  display label.
- `Back` returns to Browse Events and clears pending input.
- `Cancel` clears pending input and replies with the cancellation message.
- Valid input runs the range search and clears pending input.

Accepted format:

- Canonical format is `HH:MM-HH:MM`.
- Parser accepts harmless whitespace around the hyphen, for example
  `18:00 - 23:00`.
- Hours are `00` through `23`.
- Minutes are `00` through `59`.
- Single-digit shorthand such as `8-9` is invalid in this version.
- End time must be after start time.
- Overnight ranges such as `23:00-01:00` are rejected in this version.

Invalid range reply:

```text
Time range needs to be HH:MM-HH:MM.
Example: 18:00-23:00
```

Zero-length or overnight range reply:

```text
End time must be after start time.
Overnight ranges are not supported yet.
```

The user remains in `awaiting-range`.

### 5. Results Screen

Shown after a successful range search or `Latest 20`.

Range search header:

```text
📹 Events for 08.04.2026, 18:00-23:00
Newest first. Showing 12 events.
```

Capped range search header:

```text
📹 Events for 08.04.2026, 18:00-23:00
Newest first. Showing the newest 20 matches.
Narrow the time range if the event is missing.
```

Latest header:

```text
📹 Latest Motion Events
Newest first. Showing 20 events.
```

Event lines:

```text
#42 12:51 - front_door - 30s - Video + Photo
#41 12:47 - front_door - 30s - Video
#40 12:42 - garage - recording - Photo
```

Keyboard:

```text
[12:51 | #42 | 30s | front_door]
[12:47 | #41 | 30s | front_door]
[12:42 | #40 | recording | garage]
[Back] [Close]
```

Event button label rules:

- Format: `<HH:mm> | #<id> | <duration> | <camera>`.
- `duration` is `<n>s` when both `startedAt` and `endedAt` are valid.
- `duration` is `recording` when `endedAt` is absent.
- `duration` is `unknown` when timestamps are invalid.
- Prefer camera display name when available; otherwise use `cameraId`; otherwise
  use `camera`.
- Truncate the camera segment when needed so button labels stay compact on
  mobile Telegram clients.

Empty range result:

```text
No motion events found for 08.04.2026, 18:00-23:00.
Try a wider time range.
```

Empty latest result:

```text
No motion events recorded yet.
```

Empty-state keyboard:

```text
[Back] [Close]
```

### 6. Event Action Screen

Shown after `cam:browse:event:<id>`.

Message:

```text
📹 Event #42
Started: 08.04.2026 12:51:06
Camera: front_door
Duration: 30s
Media: Video + Photo
```

Variants:

- `Duration: recording` when the event has no `endedAt`.
- `Media: Video` when video is deliverable but no photo is available.
- `Media: Photo` when only photo is available.
- `Media: Video archived on Drive` when local video is gone but Drive fallback
  exists.
- `Media: Not ready yet` when no deliverable media exists.

Keyboard when both media types are available:

```text
[Video] [Photo]
[Back to results] [Close]
```

Keyboard when only video is available:

```text
[Video]
[Back to results] [Close]
```

Keyboard when only photo is available:

```text
[Photo]
[Back to results] [Close]
```

Keyboard when no media is currently deliverable:

```text
[Back to results] [Close]
```

Button visibility:

- Show `Video` when `videoPath` is present and `localDeleted` is false, or when
  `gdriveFileId` is present.
- Show `Photo` when `snapshotPath` is present and `localDeleted` is false.
- Do not show disabled-looking buttons; Telegram inline keyboards do not have a
  real disabled state.

`Back to results` returns to the last browse results if the handler still has
the result context in memory. If that context is unavailable, show Browse Events
instead with a short explanation:

```text
That results list expired. Start a new browse search.
```

### 7. Upload Feedback

Video delivery reuses `GetMotionVideoUseCase`.

Before local upload, send `ctx.replyWithChatAction('upload_video')`. Do not add
a persistent "uploading" text message for normal uploads; the chat action keeps
the flow concise.

If local video uploads successfully, send the video with the existing caption
format:

```text
📹 Event #42 | 08.04.2026 12:51:06 | front_door
```

If local video is unavailable or too large but Drive fallback exists, keep the
existing Drive fallback response.

If no video copy is available:

```text
Video for event #42 is not available anymore.
```

Photo delivery reuses `GetMotionPhotoUseCase`.

Before local photo upload, send `ctx.replyWithChatAction('upload_photo')`.

If photo uploads successfully, send the photo with the existing caption format:

```text
📸 Event #42 | 08.04.2026 12:51:06 | front_door
```

If the photo disappears between listing and upload, show the existing
snapshot/media unavailable response.

## Architecture

The feature stays within existing context boundaries.

- `telegram/interfaces/CameraHandler` owns the inline keyboard flow, per-user
  pending input state, callback parsing, and Telegram uploads.
- `camera/application` gets a browse read use case over `MediaRepositoryPort`.
- `camera/domain/ports/MediaRepositoryPort` is extended with browse-oriented
  query methods.
- `camera/infrastructure/DrizzleMediaRepository` and
  `InMemoryMediaRepository` implement the new query methods.
- `src/locales/en.ts` owns all new user-facing strings, input validation
  messages, result headers, and event-label formatting.

Telegram never scans `/home/pi/motion/videos` directly. Browsing uses
`motion_events` rows so video paths, snapshot paths, timestamps, event ids,
delete state, and Drive fallback remain connected.

## Data Queries

The browse use case supports two query modes:

- Latest events: newest-first, capped at 20.
- Date/time range: events where `startedAt` is inside the selected local date
  and typed range, newest-first, capped at 20.

Use `limit + 1` internally when practical so the result can expose `hasMore`.
The UI uses `hasMore` to say "Showing the newest 20 matches" without needing a
separate count query.

Suggested result shape:

```typescript
export interface BrowseMotionEventsResult {
  events: MotionEvent[];
  hasMore: boolean;
}
```

Suggested port additions:

```typescript
listLatestEvents(limit: number): Promise<MotionEvent[]>;
listEventsStartedBetween(start: Date, end: Date, limit: number): Promise<MotionEvent[]>;
```

Repository methods may fetch `limit + 1` rows and let the use case slice to 20.

Time range construction:

- Parse date input as `DD.MM.YYYY` and reject impossible dates.
- Parse time input with the rules in the Time-Range Prompt section.
- Construct start and end `Date` values in local time, matching existing
  `listEventsOnDay` behavior.
- Include events where `startedAt >= start` and `startedAt < end`.

## Telegram State

The handler keeps minimal in-memory state per Telegram user. Input state and
last-results state can share one map or live in separate maps; both are
best-effort and may disappear on process restart.

Suggested state:

```typescript
type CameraBrowsePendingInput =
  | {
      kind: 'awaiting-date';
      createdAtMs: number;
    }
  | {
      kind: 'awaiting-range';
      selectedDate: Date;
      displayLabel: string;
      createdAtMs: number;
    };

interface CameraBrowseLastResults {
  events: MotionEvent[];
  header: string;
  hasMore: boolean;
  createdAtMs: number;
}
```

State rules:

- Key pending state by Telegram user id.
- Clear pending input state on successful search, `Back`, `Cancel`, `Close`, or
  a new `/camera` dashboard open.
- Store last-results state after a successful search so `Back to results` can
  rebuild the previous list without re-entering the date/time range.
- Last-results state expires after 10 minutes.
- Ignore ordinary text when the user has no pending camera browse state.
- Pending input expires after 10 minutes.
- If pending input expires, reply:

```text
This browse search expired. Open Browse Events to start again.
```

Callback data uses the existing `cam:` namespace with browse-specific actions:

- `cam:browse`
- `cam:browse:today`
- `cam:browse:yesterday`
- `cam:browse:pick-date`
- `cam:browse:latest`
- `cam:browse:event:<id>`
- `cam:browse:video:<id>`
- `cam:browse:photo:<id>`
- `cam:browse:back`
- `cam:browse:back-results`
- `cam:browse:cancel`
- `cam:browse:close`

Stale callbacks:

- If an event id no longer exists, show the existing event-not-found response.
- If a media action is tapped after media disappears, map the domain error to
  the existing unavailable-media response.
- If `Back to results` cannot rebuild the previous list, show the expired-list
  message and a Browse Events button.

## Error Handling

Expected user input errors:

- Invalid date: explain `DD.MM.YYYY` and include an example.
- Invalid time range: explain `HH:MM-HH:MM` and include an example.
- Overnight or zero-length range: explain that end time must be after start
  time and that overnight ranges are not supported.
- No matching events: show a concise empty-state message for the selected query.
- Expired pending input: ask the user to open Browse Events again.

Domain errors from existing media use cases continue to be mapped at the
Telegram interface boundary.

## Testing

Add focused tests for:

- Time-range parser accepting canonical input and whitespace around the hyphen.
- Time-range parser rejecting bad hours, bad minutes, shorthand, zero-length
  ranges, and overnight ranges.
- Date parser rejecting impossible dates.
- Browse use case latest-event ordering, cap, and `hasMore`.
- Browse use case date/time filtering with inclusive start and exclusive end.
- Drizzle repository newest-first browse queries.
- In-memory repository browse queries.
- Camera handler browse callbacks and pending typed input transitions.
- Pending input cancellation, back behavior, and expiry.
- Event action keyboard hiding `Photo` when unavailable.
- Event action keyboard hiding `Video` when no local or Drive media exists.
- Locale result headers, event labels, prompt copy, and validation messages.

## Out of Scope

- Raw filesystem browsing outside the `motion_events` database.
- Pagination beyond the newest 20 events.
- Overnight time ranges.
- Fuzzy date or time parsing such as `evening`, `8-9`, or `last night`.
- New top-level `/camera browse` command.
- Replacing current `/camera events` output.

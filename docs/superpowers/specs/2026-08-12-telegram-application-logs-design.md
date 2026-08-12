# Telegram Application Logs Design

**Date:** 2026-08-12

**Status:** Proposed for user review

**Scope:** Admin-only PM2 application-log retrieval through `/logs`, History-menu entry points, safe text-file delivery, localization, and verification

## Summary

Extend the existing Telegram `/logs` command with two reserved, admin-only views:

- `/logs app` returns the worker's last 200 normal-output lines.
- `/logs error` returns the worker's last 200 error-output lines, including the multiline stack traces retained after the physical-line and byte-safety bounds are applied.

The streams remain separate. Each successful or empty read is delivered as a `.txt` document rather than an inline Telegram message. The History menu shows separate **Application logs** and **Errors** buttons to administrators; ordinary users continue to see only sensor logs and CSV export.

The feature reads PM2's existing output and error files on demand. It does not introduce an environment flag, proactively forward errors, change the logger backend, or alter existing sensor-history behavior.

## Goals

- Let an administrator inspect recent worker output without SSH access.
- Preserve normal output and errors as separate views.
- Preserve multiline error stacks within the selected physical-line window.
- Keep the fixed response size suitable for a Raspberry Pi 3+ runtime.
- Reuse `/logs` and the canonical receipt-bound History return flow.
- Prevent non-admin users from reading operational logs or seeing their menu actions.
- Prevent log retrieval from exposing configured secrets, PM2 metadata, or raw filesystem paths.
- Keep all new user-facing copy complete in English, Russian, and Ukrainian.

## Non-goals

- Automatic or proactive error notifications.
- An environment variable that enables error forwarding.
- Custom line counts, time ranges, search, pagination, or live streaming.
- Reading another PM2 process, arbitrary files, systemd journal entries, or Motion logs.
- Clearing, rotating, compressing, or changing PM2 logs.
- Replacing Nest's current logger or restructuring application log records.
- Changing `/logs <sensor> [count]`, `/logs <sensor> --since <duration>`, or sensor-log exports.

## User experience

### Command grammar

The existing command gains two exact reserved forms:

```text
/logs app
/logs error
```

Matching is case-insensitive after trimming whitespace. Extra arguments are invalid; `/logs app 50` does not create a configurable-count variant.

All other input continues through the existing sensor-log parser. The words `app` and `error` are reserved when they are the complete command argument. A sensor with either name remains accessible through the no-argument `/logs` picker.

### Authorization

- Existing sensor-log forms remain available to every registered user.
- Application and error views require the current persisted role to be `admin`.
- A non-admin receives the existing localized admin-required reply.
- Authorization happens before PM2 metadata lookup or filesystem access.
- Home navigation reauthorizes the admin-only action; a stale button cannot bypass a later demotion.

### Delivery

Both application-log views always use a Telegram `.txt` document, including when the chosen PM2 log file is empty.

| View | PM2 source | File name |
|---|---|---|
| `/logs app` | normal output only | `application_logs_<timestamp>.txt` |
| `/logs error` | error output only | `application_errors_<timestamp>.txt` |

The timestamp uses a filesystem-safe local date/time rendered with the configured timezone. The caption is localized and states that the attachment contains up to the latest 200 lines. Document content keeps chronological order from oldest retained line to newest.

An empty output file contains one localized explanatory line, so the command still satisfies the always-document interaction. An operational failure to query PM2, locate the process, read a log file, sanitize output, or stage the Telegram document produces a localized inline failure reply instead of an empty or misleading attachment.

### Error-stack behavior

`/logs error` selects the last 200 physical lines, not the last 200 error events. The separate 2 MiB safety ceiling may reduce that physical-line window in a pathological file; all stack frames inside the resulting bounded window are retained.

When the window begins after the start of the file, it may begin in the middle of an older stack. After ANSI removal, the reader looks for the first recognizable error-entry header in the retained window. If one exists after the first retained line, the preceding partial fragment is omitted. If no header can be recognized safely, the reader keeps the complete 200-line window instead of guessing and discarding valid data.

This rule does not fetch lines preceding the 200-line window to reconstruct an older error. It preserves complete subsequent stacks and follows the explicitly selected physical-line limit.

## Menu and navigation

The canonical History screen becomes role-aware.

```text
History
├── Sensor logs
├── CSV export
├── Application logs  (admin only)
└── Errors             (admin only)
```

Administrators see two rows:

```text
[ Sensor logs ] [ CSV export ]
[ Application logs ] [ Errors ]
```

Ordinary users retain the current first row only. The existing Home callback grammar remains bounded to Telegram's 64-byte limit; the two destinations receive distinct typed Home actions and do not encode a path, process name, stream name, role, or line count supplied by the client.

Both buttons begin the existing `logs` workflow with History as the captured origin. The document is delivered first, then a fresh authorized History screen is restored. Direct `/logs app` and `/logs error` commands use History as their natural parent. Receipt validation and current-role authorization occur before the read.

## Architecture

The change follows the repository's hexagonal dependency rule:

```text
Telegram interface
    -> system application use case
        -> application-log reader port
            <- PM2/filesystem infrastructure adapter
```

### System domain/application boundary

Add an application-log vocabulary with exactly two streams:

```ts
type ApplicationLogStream = 'output' | 'error';

interface ApplicationLogSnapshot {
  stream: ApplicationLogStream;
  lines: readonly string[];
  truncatedByByteLimit: boolean;
}
```

`ReadApplicationLogsUseCase` accepts only the stream. It owns the fixed `200`-line policy and calls `ApplicationLogReaderPort`. Callers cannot supply a process name, path, or line limit.

The system composition root binds the port to the PM2 adapter and exports the use case. Telegram imports the system application boundary, never the concrete adapter.

### PM2 adapter

`Pm2ApplicationLogReaderAdapter` performs these steps:

1. Execute PM2 directly without a shell to obtain the process list.
2. Select the exact worker name, honoring an already configured `PM2_APP_NAME` and otherwise using the repository's existing `worker` default. This feature adds no environment variable.
3. Parse only the selected process's output and error log path fields.
4. Resolve the selected path and verify it is absolute and refers to a readable regular file.
5. Open the file read-only and scan backward in bounded chunks until 200 physical lines are available or the file begins.
6. Return the retained lines in chronological order after sanitization.

PM2 process metadata can contain environment values. The adapter must never log, return, attach, or include raw PM2 stdout/stderr in a thrown error. It extracts only the application name and the two log-path fields, then discards the metadata buffer.

The adapter never uses user-provided values in a command, path, or process selector. It does not invoke a shell and does not require root privileges.

### Resource bounds

- File access is read-only.
- Backward reads use fixed-size chunks rather than loading the full PM2 log.
- The result retains at most 200 physical lines.
- A separate 2 MiB snapshot ceiling protects the Pi from a pathological single line or stack.
- If the 200-line window exceeds 2 MiB, the reader keeps the newest complete lines that fit and marks the document as byte-truncated.
- The document starts with a localized truncation notice when that exceptional ceiling is reached.
- If a single newest physical line exceeds the ceiling and no complete line can be returned, the reader raises the safe typed snapshot-too-large failure instead of returning a misleading fragment.

The normal path creates one bounded in-memory buffer suitable for grammY's `InputFile`. No persistent temporary file is required.

### Telegram interface

`LogsHandler` remains the only `/logs` command handler. It classifies the exact `app` and `error` arguments before entering the existing sensor parser.

For an application-log request it:

1. invokes the existing admin guard before creating or changing workflow state;
2. starts or receives the receipt-bound `logs` workflow;
3. asks `ReadApplicationLogsUseCase` for the selected stream;
4. renders the localized file name, caption, empty notice, and optional truncation notice;
5. delivers one `.txt` document;
6. completes through the existing workflow navigation coordinator.

Raw log content is never copied into Nest logs when retrieval or Telegram delivery fails.

### Home application and renderer

The History view carries current admin capability in the same manner as other role-aware Home screens. Add two typed actions and external destinations for application output and errors. `HomeNavigationUseCase` permits them only from History and only for a current admin. `HomeHandler` launches the correct `LogsHandler` application-log method with the validated receipt.

The renderer adds the second row only when the screen is admin-authorized. English, Russian, and Ukrainian catalogs receive matching keys for button labels, captions, empty documents, truncation notices, and failures.

## Data flow

### Direct command

```text
admin sends /logs error
  -> registered-user middleware resolves current role
  -> admin guard authorizes
  -> LogsHandler begins logs workflow with natural parent History
  -> ReadApplicationLogsUseCase requests error stream, fixed at 200 lines
  -> PM2 adapter resolves worker error path and reads bounded tail
  -> sanitizer strips ANSI and redacts secrets
  -> handler sends application_errors_<timestamp>.txt
  -> workflow completion restores authorized History
```

### History button

```text
admin taps Errors
  -> Home callback is acknowledged and serialized
  -> Home receipt and current admin role are validated
  -> HomeNavigationUseCase returns the typed error-log destination
  -> HomeHandler begins a captured-origin logs workflow
  -> same read and document-delivery path as direct command
  -> History is restored after the attachment
```

### Non-admin request

```text
registered user sends /logs app
  -> command is classified as application logs
  -> admin guard rejects with localized copy
  -> no workflow receipt is created or superseded
  -> no PM2 command runs
  -> no file opens
```

## Sanitization and sensitive data

Operational logs are privileged but are not assumed safe merely because the requester is an admin.

Before content crosses the infrastructure boundary, the adapter:

- strips ANSI control sequences;
- replaces non-empty configured values whose environment key denotes a token, secret, password, credential, or private key;
- redacts Telegram bot-token shapes, bearer-token forms, and URL user-info credentials;
- uses one stable `[REDACTED]` marker;
- preserves error type, message structure, source file, line number, column number, and stack-frame ordering when those fields are not themselves secret.

Very short or generic environment values are not used as literal replacement needles because they could corrupt ordinary words. Pattern redaction still applies. The implementation must test the project-sensitive values that are most likely to appear: Telegram credentials, admin-claim credentials, RTSP credentials, authorization headers, and credential-bearing URLs.

The raw PM2 metadata buffer and unsanitized log bytes are never passed to the handler, locale renderer, Nest logger, or domain error messages.

## Error handling

Expected infrastructure failures are mapped to typed system errors with safe metadata only:

- worker process not found;
- PM2 metadata unavailable or malformed;
- log path unavailable or invalid;
- log file missing or unreadable;
- log snapshot too large to produce safely;
- unexpected read change while tailing.

The Telegram boundary maps all expected failures to localized operational-log failure copy. Unexpected exceptions are logged with their safe stack when available, but the raw PM2 output, selected filesystem path, and raw log content are excluded. The bot reply never includes `error.message` directly.

A Telegram document-delivery failure follows the existing workflow-navigation failure path. It does not mark a failed delivery as a successful workflow completion, echo the document into application logs, or retry automatically in a loop.

If the worker is running outside PM2, such as a local development session, the command returns the same localized unavailable response. Mock and test composition may bind an in-memory application-log reader.

## Testing

### Application tests

Cover `ReadApplicationLogsUseCase` with an in-memory reader:

- maps `app` to the output stream and `error` to the error stream at the interface boundary;
- always requests exactly 200 lines;
- never accepts a process name, path, or caller-controlled count;
- returns empty and byte-truncated snapshots without changing stream identity;
- propagates each typed reader failure for interface mapping.

### PM2 adapter tests

Use a fake process executor plus temporary regular files:

- selects `worker` and the correct distinct PM2 path for each stream;
- returns the last 200 physical lines in chronological order;
- handles fewer than 200 lines and a final line without a newline;
- does not load or return older file content;
- drops only a recognizable oldest partial error fragment;
- preserves subsequent multiline stacks;
- keeps all lines when no safe error boundary is recognizable;
- strips ANSI sequences;
- redacts configured secret values and credential patterns;
- applies the 2 MiB ceiling on complete-line boundaries and reports truncation;
- rejects missing processes, malformed metadata, relative paths, directories, missing files, and read failures;
- exposes no raw PM2 metadata, environment value, raw path, or raw log content in mapped errors.

### Telegram handler tests

Extend `logs.handler.test.ts` to prove:

- existing sensor commands and picker behavior are unchanged;
- exact `app` and `error` arguments bypass sensor lookup;
- both application forms begin and complete through History;
- non-admin requests invoke neither use case nor PM2-facing port;
- successful, empty, and byte-truncated results always use `replyWithDocument`;
- output and error filenames/captions are distinct and localized;
- extra arguments are rejected without falling into sensor lookup;
- every expected application-log error maps to localized safe copy;
- document-delivery failure follows the existing receipt recovery behavior.

### Home and locale tests

Extend Home tests to prove:

- admins see separate Application logs and Errors buttons;
- ordinary users see neither button;
- both actions are valid only from History and only for admins;
- a demoted user cannot execute a stale admin button;
- each button launches the correct stream with the exact captured History receipt;
- all three locale catalogs have identical key shape and non-empty copy.

### Verification commands

The implementation plan will run targeted Vitest files for the use case, adapter, logs handler, Home navigation/handler/renderer, and locale catalogs, followed by the repository's full test, lint, and build commands.

## Documentation changes during implementation

Update the canonical product docs alongside code:

- `docs/specs/09-bot-cmd-logs.md`: add the two admin-only application-log forms, fixed line count, document delivery, reserved-token rule, and failure behavior.
- `docs/specs/06-bot-core.md`: add the role-aware History destinations and natural-parent behavior.

## Acceptance criteria

1. `/logs app` sends an admin a `.txt` document containing at most the latest 200 sanitized normal-output lines and no PM2 error-output lines.
2. `/logs error` sends an admin a `.txt` document containing at most the latest 200 sanitized error-output lines, preserving all stack frames retained after the documented 2 MiB safety bound.
3. Both commands use fixed limits, distinct filenames/captions, and the configured local timezone.
4. Empty output still produces a `.txt` document with localized explanatory content.
5. A non-admin cannot see the two History buttons and cannot cause PM2 metadata or log files to be read through a typed command or stale callback.
6. Existing sensor-log commands, picker behavior, CSV export, and ordinary-user History layout remain unchanged.
7. PM2 metadata, raw paths, unsanitized log bytes, Telegram tokens, claim credentials, RTSP credentials, authorization values, and credential-bearing URLs do not appear in Telegram documents or new application error logs.
8. Reads are bounded to 200 lines and 2 MiB without loading a complete PM2 log file.
9. PM2/filesystem failures are localized and do not crash the bot handler.
10. The feature introduces no automatic forwarding, new environment flag, database migration, root requirement, or PM2 log-configuration change.

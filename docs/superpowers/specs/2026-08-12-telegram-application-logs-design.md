# Telegram Application Logs Design

**Date:** 2026-08-12

**Status:** Proposed for user review

**Scope:** Admin-only PM2 application-log retrieval through `/logs`, History-menu entry points, safe text-file delivery, localization, and verification

## Summary

Extend the existing Telegram `/logs` command with two reserved, admin-only views:

- `/logs app` returns the worker's last 200 normal-output lines.
- `/logs error` returns up to the worker's last 200 error-output physical lines, including every multiline stack frame retained after the byte-safety bound is applied.

The streams remain separate. Each successful or empty read is delivered as a `.txt` document rather than an inline Telegram message. The History menu shows separate **Application logs** and **Errors** buttons to administrators; ordinary users continue to see only sensor logs and CSV export.

The feature reads PM2's existing output and error files on demand. It does not introduce an environment flag, proactively forward errors, change the logger backend, or alter existing sensor-history behavior.

## Goals

- Let an administrator inspect recent worker output without SSH access.
- Preserve normal output and errors as separate views.
- Preserve multiline error stacks within the selected physical-line window.
- Keep the fixed response size suitable for a Raspberry Pi 3+ runtime.
- Reuse `/logs` and the canonical receipt-bound History return flow.
- Prevent non-admin users from reading operational logs or seeing their menu actions.
- Keep PM2 metadata and raw filesystem paths out of replies and new application logs, and apply documented defense-in-depth redaction to known configured secret values and recognizable credential forms.
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

The existing command gains two exact reserved forms plus an explicit sensor-name escape form:

```text
/logs app
/logs error
/logs sensor <sensor_name> [count]
/logs sensor <sensor_name> --since <duration>
```

Matching is case-insensitive after trimming whitespace. Extra arguments are invalid; `/logs app 50` does not create a configurable-count variant.

All other input continues through the existing sensor-log parser. The words `app` and `error` are reserved when they are the complete first argument, including invalid forms such as `/logs app 50`. A current enabled sensor with either name remains accessible through the no-argument `/logs` picker. Any current, disabled, or archived sensor whose name collides with a reserved word remains directly accessible through the explicit `/logs sensor <sensor_name> ...` escape form. `/logs sensor` with no following sensor name retains the existing interpretation of a sensor literally named `sensor`.

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

`/logs error` selects the last 200 physical lines, not the last 200 error events. The separate 2 MiB safety ceiling may reduce that physical-line window in a pathological file; every complete line inside the resulting bounded window is retained.

The reader performs no error-header recognition and never discards a line based on guessed logger structure. The oldest retained line may therefore begin in the middle of an older stack. This is preferable to falsely recognizing a nested error or application message as a new entry and deleting valid frames. The reader does not fetch earlier lines to reconstruct that older stack.

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

`ReadApplicationLogsUseCase` accepts only the stream. It owns the fixed `200`-line and 2 MiB snapshot policies and calls `ApplicationLogReaderPort` with those constants. Callers cannot supply a process name, path, or limit.

The system composition root binds the port to the PM2 adapter and exports the use case. Telegram imports the system application boundary, never the concrete adapter.

### PM2 adapter

`Pm2ApplicationLogReaderAdapter` performs these steps:

1. Execute `pm2 jlist` directly with `execFile`, `shell: false`, the repository's sanitized system `PATH`, a five-second timeout, and a 2 MiB stdout/stderr buffer limit.
2. Parse the bounded stdout as untrusted JSON. Never interpolate, log, attach, or copy stdout or stderr into an error.
3. Select the exact worker name, honoring an already configured non-empty `PM2_APP_NAME` and otherwise using the repository's existing `worker` default. This feature adds no environment variable.
4. Require exactly one matching PM2 entry. Zero matches produce process-not-found; multiple matches produce process-ambiguous. The adapter never chooses the first ambiguous entry.
5. Read only that entry's `pm2_env.pm_out_log_path` and `pm2_env.pm_err_log_path`. Both must be non-empty absolute strings and must resolve to different paths; combined output/error logging is unavailable because it cannot satisfy stream separation.
6. Validate the raw selected path as absolute before normalization. Open it once with read-only and no-follow flags, then `fstat` the opened descriptor and require a regular file. Pre-open `stat` results are never used as the security decision.
7. Capture the descriptor size, scan backward with positioned fixed-size reads until 200 physical lines are available, the captured beginning is reached, or the 2 MiB raw-scan ceiling is reached. Ignore bytes appended after the captured size. Rename-based PM2 rotation remains safe because the descriptor anchors the opened inode. Truncation or a short positioned read inside the captured range produces the typed snapshot-changed failure.
8. Return the retained lines in chronological order after sanitization and final UTF-8 byte bounding.

PM2 process metadata can contain environment values. The adapter must never log, return, attach, or include raw PM2 stdout/stderr in a thrown error. It extracts only the application name and the two log-path fields, then discards the metadata buffer.

The adapter never uses user-provided values in a command, path, or process selector. It does not invoke a shell and does not require root privileges.

### Resource bounds

- File access is read-only.
- Backward reads use fixed-size chunks rather than loading the full PM2 log.
- The result retains at most 200 physical lines.
- The PM2 metadata subprocess has a five-second timeout and a 2 MiB output limit independent of the log snapshot limit.
- The backward raw-byte scan retains at most 2 MiB plus one fixed read chunk. If that boundary falls inside the oldest candidate line, the partial oldest line is discarded and the snapshot is marked byte-truncated.
- A separate 2 MiB sanitized UTF-8 snapshot ceiling protects the Pi from a pathological single line, stack, or redaction expansion.
- A physical line is delimited by LF; an optional preceding CR is removed. In a non-empty file, the final bytes at EOF form a complete physical line even when the file has no trailing LF. An empty file has zero lines, and a trailing LF does not manufacture an extra empty line.
- If the sanitized 200-line window exceeds 2 MiB, the reader keeps the newest complete sanitized lines that fit and marks the document as byte-truncated.
- The document starts with a localized truncation notice when that exceptional ceiling is reached.
- If the newest raw or sanitized physical line alone exceeds its ceiling, the reader raises the safe typed snapshot-too-large failure instead of returning a fragment.
- UTF-8 decoding preserves code points split across read chunks. Invalid UTF-8 input is replaced with the standard replacement character before byte bounding; raw undecodable bytes never cross the adapter boundary.

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

Raw log content is never copied into Nest logs when retrieval or Telegram delivery fails. A failed document delivery is followed by the existing localized History recovery flow. The durable workflow receipt may then complete because `completed` records successful terminal navigation recovery; it must not be presented or logged as successful attachment delivery.

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

Before content crosses the infrastructure boundary, the adapter applies defense-in-depth sanitization:

- strips ANSI control sequences;
- replaces configured values whose environment key denotes a token, secret, password, credential, private key, or authorization value;
- refuses the snapshot with a typed sanitization-unsafe failure when such a configured value is shorter than eight UTF-8 bytes, because literal replacement would corrupt ordinary output and returning it would risk disclosure;
- redacts Telegram bot-token shapes, Bearer and Basic authorization forms, URL user-info credentials, and sensitive URL query values named `token`, `access_token`, `api_key`, `password`, `secret`, or `key`;
- uses one stable `[REDACTED]` marker;
- preserves error type, message structure, source file, line number, column number, and stack-frame ordering when those fields are not themselves secret.

The implementation must test the project-sensitive environment values and credential forms most likely to appear: Telegram credentials, admin-claim credentials, RTSP encryption keys, authorization headers, and credential-bearing URLs. RTSP source passwords and other credentials stored encrypted in SQLite are not loaded merely to construct a redaction dictionary; source adapters remain responsible for never logging them. Consequently this sanitizer is a bounded defense-in-depth control, not a general data-loss-prevention guarantee for arbitrary secret text.

The raw PM2 metadata buffer and unsanitized log bytes are never passed to the handler, locale renderer, Nest logger, or domain error messages.

## Error handling

Expected infrastructure failures are mapped to one typed `ApplicationLogUnavailableError` carrying only a safe reason discriminator:

- `pm2-unavailable` or `pm2-metadata-invalid`;
- `process-not-found` or `process-ambiguous`;
- `stream-path-invalid` or `stream-path-collision`;
- `file-unavailable`;
- `snapshot-too-large` or `snapshot-changed`;
- `sanitization-unsafe`.

The Telegram boundary maps all expected failures to localized operational-log failure copy. Unexpected exceptions are logged with their safe stack when available, but the raw PM2 output, selected filesystem path, and raw log content are excluded. The bot reply never includes `error.message` directly.

A Telegram document-delivery failure follows the existing workflow-navigation failure path, restores History with localized unavailable copy, and may terminally complete the navigation receipt. It does not claim that the attachment was delivered, echo the document into application logs, or retry automatically in a loop.

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
- fails closed on multiple exact-name matches and identical output/error paths;
- bounds `pm2 jlist` with the sanitized path, five-second timeout, and 2 MiB buffer without leaking stdout or stderr;
- returns the last 200 physical lines in chronological order;
- handles fewer than 200 lines, CRLF, a trailing newline, Unicode split across chunks, invalid UTF-8, and a final line without a newline;
- does not load or return older file content;
- preserves every retained multiline stack line without error-header heuristics;
- strips ANSI sequences;
- redacts configured secret values and credential patterns;
- rejects configured secret values that are too short for safe literal replacement;
- applies the 2 MiB ceiling on complete-line boundaries and reports truncation;
- never retains more than the raw ceiling plus one fixed read chunk while searching for line boundaries;
- rejects missing or ambiguous processes, malformed metadata, relative paths, symlinks, directories, missing files, changed snapshots, and read failures;
- ignores post-open appends and remains bound to the opened inode across rename-based rotation;
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
- `/logs sensor app` and `/logs sensor error` reach current, disabled, or archived sensor history through the existing sensor parser;
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
- `docs/ports-and-adapters.md`: register `ApplicationLogReaderPort`, its PM2 adapter, and its in-memory test adapter in the system-context catalogue.

## Acceptance criteria

1. `/logs app` sends an admin a `.txt` document containing at most the latest 200 sanitized normal-output lines and no PM2 error-output lines.
2. `/logs error` sends an admin a `.txt` document containing at most the latest 200 sanitized error-output lines, preserving every complete physical line retained after the documented 2 MiB safety bound without guessing error headers.
3. Both commands use fixed limits, distinct filenames/captions, and the configured local timezone.
4. Empty output still produces a `.txt` document with localized explanatory content.
5. A non-admin cannot see the two History buttons and cannot cause PM2 metadata or log files to be read through a typed command or stale callback.
6. Existing sensor-log commands, picker behavior, CSV export, and ordinary-user History layout remain unchanged.
7. PM2 metadata, raw paths, unsanitized log bytes, known configured environment secrets of at least eight bytes, and recognized Telegram-token, authorization-header, URL-user-info, and sensitive-query credential forms do not appear in Telegram documents or new application error logs; unsafe shorter configured secrets make retrieval unavailable.
8. PM2 metadata lookup is bounded to five seconds and 2 MiB, while log reads are separately bounded to 200 lines, a 2 MiB raw scan plus one chunk, and a 2 MiB sanitized snapshot without loading a complete PM2 log file.
9. PM2/filesystem failures are localized and do not crash the bot handler.
10. The feature introduces no automatic forwarding, new environment flag, database migration, root requirement, or PM2 log-configuration change.
11. Zero or multiple exact PM2 process matches, combined output/error paths, symlinks, non-regular files, and snapshot changes fail closed with localized unavailable copy.

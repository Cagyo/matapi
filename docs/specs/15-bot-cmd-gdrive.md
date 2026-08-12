# 15 — `/gdrive` Command

## Dependencies
- 06-bot-core.md (private-chat role guard and workflow receipts)
- 21-gdrive.md (direct API archive lifecycle)

## Access

Administrator, private chat only.

## Syntax

```text
/gdrive connect
/gdrive status
/gdrive disconnect
```

## Connect

The Storage & backup entry and `/gdrive connect` render the same localized
command/menu guide, including the Google Cloud Console link and a receipt-origin
Cancel control. Starting the guide creates one secret-free preparation owned by
the administrator, private chat, and workflow receipt. The durable workflow
receipt lasts 24 hours; no client secret, device code, token, or credential JSON
is retained in preparation state.

Sending a document is the continue action. The handler creates a fresh ten-minute
pending generation only when it receives the associated document, so time spent
following the guide does not consume the authorization window. Forwarded,
oversized, malformed, Web, Desktop, and non-private documents are rejected before
credential use. Every document associated with a preparation is deletion-attempted
on success, validation failure, provider failure, expiry, and staged-slot
contention. A failed Telegram deletion produces a localized manual-deletion
warning; failure to deliver that warning does not replace the setup outcome.

Device authorization displays only Google's unchanged verification URL and
case-sensitive user code. Polling and confirmation share the effective deadline,
which is the earlier of the pending generation expiry and Google's challenge
expiry. Confirmation rechecks the live account identity before atomic activation,
so a failed replacement preserves the active connection. A second administrator
who encounters the single staged slot receives retryable busy guidance and can
retry the same document without cancelling the staged owner or restarting the
24-hour preparation.

Callback payloads are exact, opaque bindings: `wr:<receipt>:o` returns or cancels
to the receipt origin; `wr:<receipt>:h` opens Home;
`gdc:<receipt>:<generation>:a` confirms authorization;
`gdc:<receipt>:<generation>:c` cancels that setup;
`gdc:<receipt>:<generation>:d` confirms disconnect; and
`gdc:<receipt>:<generation>:x` cancels disconnect. They contain no credentials.
Localized typed replies keep malformed document, unsupported client, rejected
client, policy, rate-limit, busy, expiry, temporary transport, malformed provider
success, and authorization-pending outcomes distinct; provider-controlled text is
never copied into a reply.

## Status

The handler calls `ReportDriveStatusUseCase` and reports the active generation,
permission identity, quota, archive/attempt counts, last successful operations,
reclamation state, detached/missing objects, retired audit generations, and
required action. Folder links are shown only in the administrator's private
chat. Errors are sanitized and never include credentials, tokens, session URLs,
provider response bodies, or bot-token-bearing URLs.

## Disconnect

Disconnect uses an exact confirmation receipt. It cancels polling, clears live
secret references, and preserves remote objects plus retired-generation audit
history. It never performs remote deletion.

## Contextual workflow return

Drive status and setup use `drive-status` and `drive-setup` receipts with
Storage & backup as their natural parent. `wr:<id>:o` restores that authorized
parent; `wr:<id>:h` opens Home. Callback data contains only the receipt ID and
destination. Demotion, restart, duplicate callbacks, and superseded receipts
fail closed without mutating newer work.

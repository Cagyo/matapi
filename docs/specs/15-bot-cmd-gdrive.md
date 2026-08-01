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

The handler begins a receipt-bound `drive-setup` workflow and requests a Google
OAuth installed-client JSON document. Forwarded, oversized, malformed, or
non-private documents are rejected before parsing. The document is deleted
after reading; if Telegram deletion fails, the administrator receives a manual
deletion warning. Device authorization presents only Google's verification URL
and user code. Confirmation rechecks the live account identity before activating
the staged generation, so a failed replacement preserves the prior connection.

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

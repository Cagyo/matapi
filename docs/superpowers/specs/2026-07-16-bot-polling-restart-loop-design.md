# Bot Polling Restart Loop Design

## Problem

`CheckBotPollingService` restarts grammY when the most recently received
Telegram update is at least two minutes old. A successful restart does not
change that timestamp, so every later 30-second watchdog tick sees the same
stale value and restarts the runner again. The resulting restart storm can
prevent callback updates, including the stateless `ho` Open-new-Home action,
from reaching registered handlers.

## Approaches Considered

1. **Reset update freshness when the runner is restarted (recommended).**
   Clear `lastUpdateAt` immediately before starting the replacement runner.
   The watchdog already defines `null` as healthy for a newly started runner,
   so this reuses the existing lifecycle contract and stops the restart storm.
2. **Disable the polling watchdog.** This removes the storm but also removes
   recovery from the half-open polling condition the watchdog was introduced
   to handle.
3. **Track successful `getUpdates` poll completions.** This is a stronger
   long-term health signal than user activity, but grammY's runner does not
   currently expose that signal through the worker's port. Introducing it is a
   wider library-integration and architecture change than this bug requires.

## Design

`GrammyBotGateway.restart()` will start the replacement runner, install it,
and then clear its last-update timestamp as part of the runner lifecycle
transition. A fresh runner therefore cannot inherit the stale timestamp that
caused its predecessor to be restarted.

The two-minute threshold, 30-second check interval, registry port, handler
ordering, callback acknowledgement, and Home opening protocol remain
unchanged. A later real Telegram update sets `lastUpdateAt` normally. If that
new timestamp becomes stale, one later recovery restart may occur, but it will
not repeat indefinitely without another update.

## Error Handling

If stopping the current runner or starting its replacement throws, the
timestamp remains unchanged and the existing watchdog retry behavior remains
available on the next tick. The timestamp is cleared only after `run(this.bot)`
successfully creates and installs the replacement.

## Testing

Add a gateway regression test that starts with a stale `lastUpdateAt`, invokes
`restart()`, and asserts that the timestamp is reset while a replacement
runner is created. Retain the existing watchdog tests proving that stale
timestamps trigger recovery and `null` timestamps are healthy. Then run the
focused polling/Telegram suites and the production build.

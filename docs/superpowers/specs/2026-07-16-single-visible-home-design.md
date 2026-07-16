# Single Visible Home Design

**Date:** 2026-07-16
**Status:** Approved

## Goal

Every successful Home open leaves the newly sent Home as the only visible Home
menu. When the user recovers through **Open new Home**, the stale recovery
prompt is removed as well.

## Behavior

### Reservation promotion

Drizzle's SQLite `timestamp` mode stores Unix seconds. Home reservations are
created from JavaScript `Date` values that normally include milliseconds, so
comparing the in-memory expiry with its persisted round-trip at millisecond
precision makes an otherwise identical reservation appear different. The
store compares expiration values at the column's one-second storage precision;
the token, revision, view, user, and chat identity remain exact. This prevents
a normal `/menu` open from sending a Home and then immediately reporting it as
superseded.

### Visible-message cleanup

`OpenHomeUseCase` keeps the existing reserve → send → promote ordering. Only
after the replacement becomes authoritative does it ask the Home delivery port
to delete the previous active Home. The deletion is best-effort: an expired,
already removed, or otherwise undeletable Telegram message cannot invalidate
the newly promoted Home.

If sending or promotion fails, the previous active Home is retained. A newly
sent message that loses promotion continues to have only its keyboard stripped,
because deleting it could race with another authority transition and the
existing stale-callback safety already makes it inert.

For the `ho` recovery callback, `HomeHandler` removes the callback's recovery
message only after `OpenHomeUseCase` reports `opened`. A failed or superseded
open retains the recovery prompt so the user is not left without a recovery
path. Recovery-message deletion is also best-effort.

## Architecture

The application layer owns previous-Home cleanup through a new
`HomeMessageDeliveryPort.deleteMessage(chatId, messageId)` operation. The real
Telegram adapter maps it to grammY's `bot.api.deleteMessage`; the in-memory
adapter records it for use-case tests. The interface handler uses the current
grammY context only for the recovery prompt, because that message is
interface-owned and is not part of Home session authority.

## Verification

- A real SQLite adapter test uses nonzero milliseconds and proves the stored
  reservation still promotes successfully.
- Use-case tests prove deletion happens only after successful promotion and
  that deletion failure does not change the `opened` result.
- Adapter tests prove the exact chat/message pair is passed to Telegram.
- Handler tests prove `ho` removes its source only after a successful open and
  ignores Telegram deletion failures.
- Existing superseded and send-failure tests continue to prove that no usable
  Home is removed on failure.

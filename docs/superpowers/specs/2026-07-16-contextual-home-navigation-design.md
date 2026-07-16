# Contextual Home Navigation Design

**Date:** 2026-07-16

**Status:** Proposed for user review

**Scope:** Telegram Home navigation, external workflows, return behavior, copy, localization, and mobile keyboard layout

## Summary

Home navigation must preserve context instead of resetting every completed or cancelled action to Home. Every external workflow records the exact Home screen that launched it and restores that screen after cancellation or terminal completion. Direct commands use a stable natural parent when no launch screen exists.

The design removes **Close Home**, gives Back, Cancel, and Home distinct meanings, and replaces the static `rh:<workflow>:<phase>` callback with a durable receipt-bound protocol. A stale button can never cancel newer work. Started long-running work continues when the user navigates away.

The restored menu is always a new authoritative Home message at the bottom of the Telegram chat. Successful and failed outcomes remain visible immediately above it.

## Goals

- Make Back, Cancel, Home, completion, and long-running navigation predictable.
- Restore the exact launching menu after external workflows.
- Use natural-parent fallbacks for direct commands.
- Prevent an old or repeated Telegram button from mutating newer workflow state.
- Preserve return intent across a worker restart without pretending that an in-memory draft survived.
- Reauthorize captured destinations after role or data changes.
- Keep the latest usable menu visible at the bottom of the chat.
- Provide complete English, Russian, and Ukrainian copy.
- Keep keyboards readable on common iOS, Android, and desktop Telegram clients.

## Non-goals

- Persisting unfinished sensor, Drive, import, camera-source, or update-confirmation drafts across restart.
- Cancelling work that has already started, including CSV generation, package updates, cleanup, uploads, and live streams.
- Replacing Telegram inline keyboards with another interaction model.
- Redesigning sensor lists, notification-target pagination, or unrelated command output.
- Introducing a general browser-style navigation stack. One captured origin per external workflow is sufficient.

## Product invariants

1. There is one authoritative Home message per user/private-chat pair.
2. There is at most one active interactive external workflow per user/private-chat pair.
3. A new interactive workflow supersedes the previous interactive workflow.
4. Superseding a cancellable draft discards only that exact draft.
5. Superseding or leaving a running workflow never stops its started work.
6. Every mutation caused by a callback is idempotent and bound to a receipt ID.
7. Current authorization and current data determine whether a stored origin may be rendered.
8. Telegram delivery failure cannot make a stale button authoritative again.

## Vocabulary and interaction semantics

| Control | Meaning |
|---|---|
| **Back** | Move to the previous step inside the current wizard and preserve its draft. |
| **Back to _destination_** | Leave the external workflow and restore its captured origin. If work is running, it continues. |
| **Cancel _workflow_** | Discard the exact unfinished draft and restore its captured origin. No separate “Cancelled” message is sent. |
| **Home** | Discard the exact unfinished draft, if any, and open Home. Started work continues. |
| **Finish** | Send a concise outcome, then restore the captured origin automatically. |

Generic **Cancel** is not used when the consequence is ambiguous. Labels name the operation, for example **Cancel sensor setup**, **Cancel import**, **Cancel Drive setup**, or **Cancel system update**.

## Information architecture

### Home hierarchy

```text
Home
├── Sensors
├── Camera
├── Notifications
└── More
    ├── History
    │   ├── Logs
    │   └── CSV export
    ├── Language
    ├── Help
    └── Admin tools
        ├── Sensor setup
        │   ├── Add
        │   ├── Edit
        │   ├── Remove
        │   ├── Import
        │   └── Export
        ├── Storage & backup
        │   ├── Drive status
        │   ├── Connect Drive
        │   └── Clean up storage
        ├── System
        │   ├── Health
        │   ├── System packages
        │   ├── Restart worker
        │   └── Cleanup threshold
        └── Create invite
```

### Natural parents for direct commands

| Workflow | Direct-command fallback |
|---|---|
| Logs, CSV | History |
| Language, Help | More |
| Add/Edit/Remove/Import/Export sensors | Sensor setup |
| Drive status, Drive setup | Storage & backup |
| Health, package update, restart | System |
| Create invite | Admin tools |
| Camera | Home |

### Origin precedence

Return resolution uses this order:

1. The exact captured origin, if it is still valid and authorized.
2. The nearest valid authorized ancestor.
3. The workflow's natural parent for a direct command or unusable receipt payload.
4. Home as the final recovery destination.

For example, Camera launched from a future Sensors entry returns to Sensors. `/camera` typed directly returns to Home.

## Navigation controls

### Home-owned menus

Nested Home screens end with at most two navigation buttons in one row:

```text
[ « Parent destination ] [ 🏠 Home ]
```

When the parent is Home, only **🏠 Home** is shown. The interface never displays two controls with the same result.

Destination labels have dedicated locale keys:

- `« More`
- `« History`
- `« Admin tools`
- `« Sensor setup`
- `« Storage & backup`
- `« System`
- `« Notifications`

### Wizard screens

An intermediate wizard step uses separate rows:

```text
[ « Previous step ]
[ Cancel sensor setup ] [ 🏠 Home ]
```

The first wizard step omits **Previous step**. Cancel restores the workflow origin. Home cancels the same exact draft and opens Home.

### Long-running work

Once work has started, exit copy states the consequence:

- `« System · update continues`
- `« History · export continues`
- `« Home · live stream continues`

Started work is never described as cancelled. When a running operation finishes after the user has already returned, it sends its terminal result without opening another menu or changing the user's current Home screen.

## External workflow return receipt

### Reuse the existing receipt table

The design extends `HomeActionReceipt` with a strict `workflow-return` variant and reuses `home_action_receipts`. No database schema migration is required: `kind`, `status`, and `payload` are already text-backed, and the primary key already provides one row per `(userId, chatId, kind)`.

Using one constant kind, `workflow-return`, makes the table enforce one current interactive external workflow per user/private-chat pair. Existing pause, cleanup, restart, and undo receipt kinds remain independent.

### Receipt shape

```ts
type WorkflowReturnReceipt = {
  id: string;                 // 16-character base64url token
  userId: number;
  chatId: number;
  kind: 'workflow-return';
  sessionToken: string | null;
  status: 'pending' | 'executing' | 'returned' | 'completed';
  expiresAt: Date;
  payload: {
    workflow: ExternalWorkflow;
    phase: 'cancellable' | 'running';
    originSource: 'captured' | 'natural-parent';
    origin: HomeView;
  };
};
```

The receipt codec is strict and canonical. It rejects unknown keys, invalid workflows, malformed Home views, invalid statuses, invalid numeric identity, oversized payloads, and non-canonical JSON. The application use case separately requires a currently registered user in a private chat.

Captured Home launches set `sessionToken` to the validated active Home token. Direct commands use `null` and store the natural parent explicitly.

### Receipt lifetime

- A workflow-return receipt expires 24 hours after its last valid workflow transition.
- Valid transitions may refresh the expiry, but an arbitrary callback may not.
- An expired receipt never cancels state.
- If the expired row can be decoded, return falls back through the normal authorization chain; otherwise it opens the natural parent or Home.

### Callback grammar

New contextual return callbacks bind both the receipt and requested destination:

```text
wr:<16-character-receipt-id>:<o|h>
```

`o` restores the authorized origin; `h` cancels only the receipt-bound draft and opens Home. The destination code is the only client-provided behavior flag. Workflow, phase, origin, user, and chat still come exclusively from the validated receipt and current update context.

The maximum encoded size is 21 UTF-8 bytes, below Telegram's 64-byte callback limit. The acknowledgement middleware recognizes only the exact grammar:

```text
^wr:[A-Za-z0-9_-]{16}:[oh]$
```

The callback does not trust workflow, phase, origin, user, or chat values from Telegram. Those values come from the validated receipt and current update context.

### State transitions

```text
begin workflow
    └── pending
          ├── update phase/origin ──> pending
          ├── user exits ──────────> executing ──restore──> returned
          └── workflow finishes ───> executing ──result+restore──> completed

returned + running job finishes ──> completed (result only)
```

- `pending → executing` is an immediate-transaction CAS claim.
- A duplicate tap during `executing` may repeat receipt-ID-matched cleanup because that cleanup is idempotent, then retry restoration. It may not repeat a completed domain effect.
- `returned` and `completed` acknowledge as already handled and perform no mutation.
- A mismatched receipt ID is superseded and performs no mutation.
- Starting another workflow replaces the `workflow-return` row with a new ID, making every older return button stale.

### Binding in-memory draft state

Every interface-local FSM state stores the workflow receipt ID. Cleanup is conditional:

```text
delete state only when state.receiptId === claimedReceipt.id
```

This second guard ensures that an old callback cannot delete a newer draft even if interface orchestration is accidentally invoked with the wrong workflow.

## Application and interface architecture

The implementation follows the Telegram context's existing hexagonal layering.

### Domain

- Move the shared external-workflow vocabulary out of `interfaces/return-home.ts` into a Telegram domain file.
- Add the strict `workflow-return` receipt variant and origin codec.
- Keep grammY and Telegram callback objects out of domain types.

### Application

Add focused use cases around the existing `HomeActionRepositoryPort`:

- **BeginWorkflowReturnUseCase**: supersede the current interactive receipt and create the next receipt.
- **UpdateWorkflowReturnUseCase**: change cancellable/running phase with receipt-ID CAS.
- **ClaimWorkflowReturnUseCase**: atomically claim exit or terminal restoration.
- **CompleteWorkflowReturnUseCase**: mark returned/completed after successful restoration.
- **ResolveWorkflowOriginUseCase**: reauthorize and normalize the stored origin.
- **RestoreWorkflowOriginUseCase**: open a fresh authoritative Home at the resolved origin.

The repository port exposes semantic operations rather than raw SQL-shaped update methods. The Drizzle adapter uses immediate transactions; the in-memory adapter mirrors identical outcomes for tests and mock mode.

`GetHomeScreenUseCase` rejects or normalizes admin-only views for a non-admin. Directly supplying an admin view is no longer sufficient authorization.

### Interfaces

Add a shared `WorkflowNavigationCoordinator` in `telegram/interfaces/`. It owns grammY-facing orchestration:

- promptly acknowledge the callback;
- invoke application receipt use cases;
- clear exact interface-local state through workflow-specific cancellers;
- send results and retry controls;
- request restoration;
- never query Drizzle directly.

`HomeHandler` passes the validated current `HomeView` and active Home token when launching an external workflow. Direct command handlers request their natural-parent origin.

Any valid Home navigation while a cancellable external workflow is active first cancels that exact receipt-bound draft. Any valid Home navigation while the receipt is running marks it returned without stopping the job. This applies equally to **🏠 Home**, `/menu`, and navigation buttons on the authoritative Home message.

Starting a new external workflow uses the same coordinator to supersede and clean the previous exact draft before beginning the new workflow.

## Core flows

### Cancel an unfinished sensor picker

1. Sensor setup launches Edit Sensor with a captured `admin-sensor-setup` origin.
2. The coordinator creates a `workflow-return` receipt and the config FSM stores its ID.
3. The user taps **Cancel sensor setup**.
4. The coordinator claims that receipt.
5. Config deletes the FSM state only if receipt IDs match.
6. No “Cancelled” message is sent.
7. A fresh authoritative Sensor setup menu is sent as the newest message.
8. The previous Home message is deleted best-effort; any surviving callbacks remain stale through Home token/revision validation.

### Finish an action

1. The workflow completes successfully or with a terminal failure.
2. The handler sends one concise localized result.
3. If the receipt is still pending, it is claimed and the captured origin is restored below the result.
4. If the user already returned while work was running, only the result is sent; current Home navigation is not changed.

### Change language

1. Language is persisted.
2. Callback feedback uses the newly selected language.
3. More is restored immediately in the newly selected language.
4. The language selector is not rerendered after success.
5. If restoration fails, the selector remains with a localized **Return to More** retry action.

### Direct command

1. `/config modify` begins with natural parent Sensor setup.
2. Any previous cancellable workflow for this user/chat is superseded and cleaned by exact receipt ID.
3. Cancel or terminal completion restores Sensor setup.
4. A pre-existing Home at another screen does not override the direct command's natural parent.

### Long-running action

1. A pending confirmation remains cancellable.
2. After the action is irreversibly started, the receipt phase changes to `running` before success is reported.
3. The status copy says that work continues in the background.
4. Returning restores the captured origin and marks the receipt `returned`.
5. Terminal completion later sends its result without moving or replacing the user's current Home.

Checks that cannot be aborted after dispatch use the same running semantics. Leaving a “checking” message does not suppress its later result, but the later result does not steal navigation focus.

## Authorization and dynamic-origin recovery

Return always uses the role loaded for the current Telegram update.

| Stored origin problem | Recovery |
|---|---|
| Admin was demoted | Walk to More, then Home if necessary. |
| Sensor or camera target disappeared | Restore its containing list. |
| Page index no longer exists | Clamp to the last valid page. |
| Origin payload is malformed | Use the workflow's natural parent. |
| Natural parent is unauthorized | Walk to the nearest authorized ancestor. |
| User is no longer registered | Ignore the callback under the registered-user policy. |

Fallback adds a concise localized notice such as **Your access changed, so we returned you to More.** It never exposes role or database internals.

## Restart behavior

- The durable receipt and origin survive restart.
- Interface-local drafts do not survive restart.
- A receipt that claims a cancellable draft after restart performs idempotent no-op cleanup, restores the origin, and shows **The unfinished setup expired when the bot restarted.**
- A running job uses its own durable job/source of truth. Return receipts do not pretend to recreate job state.
- If job state is unavailable after restart, the result explains that status could not be recovered and restores the origin.
- `executing` return receipts are resumable: retry may repeat restoration, but never workflow cleanup or domain effects.

## Telegram delivery failure contract

Result delivery and Home restoration are not atomic, so the coordinator uses compensation:

1. Claim the receipt before cleanup or terminal restoration.
2. Perform idempotent exact cleanup when required.
3. Attempt to send the result when a result exists.
4. Open a fresh authoritative Home at the resolved origin.
5. Mark the receipt returned/completed only after Home promotion succeeds.

Failure handling:

| Failure | Behavior |
|---|---|
| Result send fails, Home succeeds | Prepend a one-line localized outcome notice to the new Home message. The notice is presentation-only and is not persisted in `HomeView`. |
| Home restoration fails after result | Add **Retry return** to the result message. Keep the receipt resumable. |
| Cancel cleanup succeeds, Home fails | Replace the cancelled workflow keyboard with **Retry return**. Do not recreate the draft. |
| Editing retry markup fails | Send a best-effort localized recovery reply; keep the receipt resumable. |
| Previous Home deletion fails | No functional impact; its token/revision/message identity is stale. |
| Callback acknowledgement fails | Continue serialized processing; never repeat mutation merely to acknowledge. |

Errors use typed domain/application outcomes and localized interface mapping. Logs may include receipt kind and opaque ID but never bot tokens, chat IDs, or user-entered secrets.

## Copy system

Required new localized concepts include:

- Destination-aware Back labels.
- Operation-specific cancellation labels.
- “continues in the background” status copy.
- Already handled and expired-control feedback.
- Restart-expired draft feedback.
- Authorization fallback feedback.
- Retry-return labels and restoration failure copy.
- Outcome notices used when result delivery fails.

Copy rules:

- Use one noun consistently: **Home**, **Sensor setup**, **Storage & backup**, **System**, **History**, **More**.
- Name destructive abandonment: **Cancel sensor setup**, not generic **Cancel**.
- Do not show “Cancelled.” when the restored menu already communicates the outcome.
- Do not use raw error messages or implementation terms such as receipt, CAS, FSM, or callback.
- Translate complete strings; do not build destination labels by concatenation.

## Mobile and localization adaptation

- Navigation rows contain no more than two buttons.
- Operation rows contain no more than two buttons where labels are longer than a short noun.
- Sensor setup changes from a three-button row to:

  ```text
  [ Add ] [ Edit ]
  [ Remove ] [ Import ]
  [ Export ]
  [ « Admin tools ] [ 🏠 Home ]
  ```

- System moves cleanup-threshold choices behind **Cleanup threshold**:

  ```text
  [ Health ] [ System packages ]
  [ Restart worker ]
  [ Cleanup threshold ]
  [ « Admin tools ] [ 🏠 Home ]
  ```

- The threshold screen owns the five values plus **« System** and **🏠 Home**.
- English, Russian, and Ukrainian keyboard snapshots verify the longest navigation and cancellation labels.
- If a two-button row is unreadable in a target Telegram client, destination Back occupies its own row; functionality is never hidden or abbreviated into jargon.

## Compatibility and removal

### Close Home

- Stop rendering **Close Home** immediately.
- Remove the close use case, close delivery behavior, recovery copy, DI wiring, and normal action tests.
- For one compatibility release, decode legacy Home action `x` only as a non-destructive refresh of the current authorized screen. It never closes Home and is never emitted by new keyboards.
- After the active message is refreshed, the legacy button disappears.

### Static `rh:` callbacks

- New messages never emit `rh:` callbacks.
- Legacy `rh:` callbacks remain acknowledged for one compatibility release.
- They never cancel current state because they lack a receipt ID.
- They show **This old control was replaced. Open /menu to continue.** and perform no navigation or state mutation.
- The legacy parser and compatibility route are removed in the next planned protocol cleanup.

## Testing strategy

### Domain unit tests

- Strict `workflow-return` receipt codec: valid variants, unknown keys, malformed views, invalid statuses, expiry, payload size, and canonical encoding.
- `wr:` callback exact grammar, origin/Home destination decoding, UTF-8 byte bound, trailing newline rejection, and invalid-token rejection.
- Origin authorization and ancestor fallback for every Home view and role.

### Application/use-case tests

- Begin supersedes exactly one previous interactive receipt.
- Old receipt IDs cannot claim or cancel a new workflow.
- Pending-to-executing CAS permits one owner.
- Executing retry restores without repeating cleanup.
- Returned/completed callbacks are idempotent.
- Direct commands choose their natural parents.
- Demotion and dynamic-target deletion select the correct ancestor.
- Expired and malformed origins fall back safely.

### Repository contract tests

Run the same contract against Drizzle and in-memory adapters:

- replacement, claim, phase update, return, completion, expiry, and restart readback;
- concurrent claims and stale IDs;
- transaction rollback on injected failure;
- one `workflow-return` row coexisting with confirmation and undo receipt kinds.

### Interface tests

- Cancel selection restores Sensor setup without a “Cancelled” reply.
- Success/failure result appears immediately before the restored menu.
- Language returns to localized More.
- Help, Invite, Health, export, empty, and error paths all restore their origins.
- Home and `/menu` cancel only the exact cancellable draft.
- Home never stops running work.
- Starting a second workflow supersedes and cleans the first exact draft.
- Long-running completion after return does not move current Home.
- Retry-return behavior for result-send, Home-send, edit, and delete failures.
- Legacy `x` and `rh:` controls are non-destructive.

### Integration and manual verification

- Restart with a pending config receipt: draft expires, Sensor setup restores.
- Restart with a running job: return restores origin and job truth comes from its durable owner.
- Demote an admin mid-workflow and verify More/Home fallback.
- Tap old and current buttons rapidly; only the current receipt mutates state.
- Verify callback acknowledgement remains prompt under serialized processing.
- Verify keyboard layouts and copy in English, Russian, and Ukrainian on at least one iOS Telegram client, one Android Telegram client, and Telegram Desktop.

## Documentation updates

Implementation updates the following sources of truth:

- `docs/specs/06-bot-core.md`: callback grammar, authority, compatibility, and lifecycle.
- Matching command specs for config, camera, Drive, update, logs/CSV, and users/invite.
- `docs/ports-and-adapters.md`: extended Home action receipt contract and coordinator boundary.
- `docs/error-handling.md`: workflow-return outcome mapping.

No migration file is generated because the existing `home_action_receipts` schema is reused unchanged.

## Acceptance criteria

1. No new keyboard displays **Close Home**.
2. Cancel in Select Sensor to Edit/Remove restores Sensor setup immediately with no cancellation message.
3. Every external workflow restores its exact valid origin after terminal success or failure.
4. Direct commands restore their documented natural parent.
5. Language selection restores More in the selected language.
6. Back preserves wizard draft; Cancel and Home discard only the exact current draft.
7. Started work continues after Back/Home and says so explicitly.
8. An old, duplicate, expired, or superseded button cannot mutate current workflow state.
9. Return intent survives restart while in-memory drafts expire honestly.
10. Demotion and deleted dynamic targets fall back to the nearest valid authorized ancestor.
11. A restored menu is the newest authoritative Home message.
12. Result and restoration delivery failures provide an idempotent retry path.
13. English, Russian, and Ukrainian catalogs and keyboard snapshots cover all new copy.
14. Drizzle and in-memory receipt adapters pass the same concurrency contract.
15. Existing Home token/revision/message authority remains unchanged for Home-owned callbacks.

## Self-review record

- No unresolved placeholders or TODOs.
- The UX rules, callback protocol, receipt lifecycle, failure compensation, restart behavior, authorization fallback, and tests use consistent terminology.
- The design remains one bounded implementation slice and reuses existing receipt persistence instead of adding a new table.
- The information architecture and mobile layout changes are limited to navigation clarity and the density issues found by the approved critique.

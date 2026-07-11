# Security Report Remediation Design

## Scope

Remediate the four validated findings in the 2026-07-11 security report while
preserving normal Telegram administration, Drive authentication, and offline
notification delivery. The working tree contains unrelated camera and mute
changes; this work must not modify or stage them.

## Decisions

- First-run setup is loopback-only. Remote setup uses SSH port forwarding.
- Setup uses a one-time terminal-displayed pairing secret; loopback alone is
  not considered sufficient ownership proof because a browser can be induced
  to post to a loopback service.
- Privileged Telegram target selection uses immutable Telegram IDs. A name is
  accepted only when it resolves to exactly one user.
- A Drive-auth continuation checks the sender's current role immediately
  before it invokes the persistent configuration update.
- The durable queue has a focused global row bound. On overflow it retains
  newer state by evicting the oldest unsent event and logs the loss.

## 1. Telegram identity and stale authorization

`/promote` and `/demote` will support an explicit `id:<telegram-id>` target.
Existing human-readable input remains compatible only when its normalized
lookup finds exactly one user. The user repository exposes all normalized
matches, and the use cases throw a typed `AmbiguousUserTargetError` for two or
more matches. The handlers map it to localized copy that lists the candidate
Telegram IDs for the requesting administrator, enabling an explicit retry.

This removes the implicit first-row selection without making mutable display
names unique. Both role-changing commands use the same resolver, so the
wrong-target demotion sibling is fixed too.

`GdriveAuthHandler` gains a shared continuation authorization check. Before a
pending text or document input is accepted, downloaded, or passed to
`UpdateGdriveAuthUseCase`, it resolves the sender's current role. A non-admin
continuation clears its pending state, replies with the existing admin-required
locale string, and never reaches the configuration writer. The check is placed
immediately before the use-case invocation to minimize the remaining async
window without introducing a cross-context authorization dependency.

## 2. Setup ownership boundary

The setup server binds only to `127.0.0.1`; installation output documents
`ssh -L 3000:127.0.0.1:3000 <pi>` for remote browser use instead of publishing
a LAN address.

At startup, the wizard creates a cryptographically random, one-time pairing
secret and prints it only to the terminal. The server stores only a digest and
uses a length-safe, timing-safe comparison. The browser supplies the secret in
the request body (never a URL) for every state-changing route, including token
validation, step two, and finalization. The secret expires with the existing
30-minute wizard timeout and becomes unusable after successful finalization.
Missing or invalid secrets return 403 without mutating configuration or
revealing the generated claim credential.

`/finish` independently calls `validateToken` immediately before `writeConfig`.
An invalid token or unavailable Telegram API returns a retryable error and
leaves `.env` and `features.json` untouched. A valid request retains the
existing one-shot configuration and claim-token behavior.

The wizard will be factored into an importable server factory with injected
install directory, token validator, writer, and timer controls. The executable
entrypoint remains responsible for one-shot checks, secret generation, terminal
output, timeout, and process exit. This permits real loopback HTTP tests
without starting a production listener during test import.

## 3. Durable queue bound

The durable event queue receives the smallest complete bound for the reported
unbounded-allocation finding:

- `EVENT_MAX_UNSENT=500` limits all unsent rows and is configurable through
  the existing event queue options.
- In one SQLite transaction, an enqueue at capacity deletes the oldest row
  with `sent_at IS NULL`, ordered by creation time and then ID, before it
  inserts the new event.
- The in-memory repository implements the same newest-first behavior so
  use-case tests preserve production semantics.

Eviction is deliberately observable: the repository writes rate-limited
warnings at the first drop and cumulative powers of two, containing only the
drop count and configured bound. The normal at-least-once guarantee remains
unchanged until the configured capacity is exhausted; an evicted event is an
explicitly recorded overflow loss. The force-aggregation threshold is
validated not to exceed this maximum.

## Error handling and observability

Telegram-facing failures are typed domain errors and map to locale entries;
raw errors, tokens, pairing secrets, chat IDs, payloads, and claim credentials
are never logged. Queue eviction/rejection warnings use cumulative
power-of-two counts plus configured limits, matching the existing ingress
backpressure convention.

## Validation

Focused tests will prove:

1. duplicate names cannot change either user's role; an explicit immutable ID
   changes only the selected user;
2. demoted Drive-auth participants cannot write configuration through text or
   document continuations, while a current admin still can;
3. setup rejects unpaired and invalid-token finalization without creating
   configuration, and accepts paired valid finalization over loopback;
4. queue admission is atomic under concurrent writers, retains only the newest
   500 unsent rows, preserves sent rows, and records rate-limited overflow
   warnings; and
5. existing legitimate promotion, Drive auth, setup, notification, and drain
   behavior continues to pass its owning test suites.

## Out of scope

This change does not introduce a general authorization framework, a Telegram
admin UI, a complete security review of deferred scan surfaces, or a full
disk-budget system. Byte quotas, critical-event reservation, delivery leases,
and whole-database disk-pressure management are follow-up hardening work after
measuring deployed MQTT rates and Pi storage behavior.

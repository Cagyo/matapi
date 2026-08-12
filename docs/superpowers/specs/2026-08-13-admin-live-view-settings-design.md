# Admin Live View Settings — Design

## Status

Approved during brainstorming on 2026-08-13. This document is the design
authority for an admin-only Telegram workflow that configures the prerequisites
for **Watch live**. It does not implement the feature.

## Purpose

Administrators must be able to configure the prerequisites for on-demand live
camera viewing without editing `.env` on the Raspberry Pi. The workflow lives at
**Home → More → Admin tools → Live view setup** and manages only:

- whether Watch live is enabled; and
- the private camera networks that RTSP sources may reach.

The settings are startup configuration. Every committed change therefore uses
an explicit **Save & restart** confirmation. Existing camera-source credentials
and advanced performance settings remain in their current owners.

## Scope

### In scope

- A dedicated admin-only Live view setup workflow.
- An Enable/Disable control.
- One or more allowed camera CIDRs.
- Detected private LAN subnets offered as optional suggestions.
- Manual CIDR entry, removal, review, and confirmation.
- A typed, versioned settings file as the single source of truth.
- A fail-closed privileged boundary for updating the root-owned RTSP egress
  policy.
- Safe coordination with live sessions and process restart.
- One-time migration from the two legacy prerequisite environment values.
- Localized English, Russian, and Ukrainian Telegram copy.

### Out of scope

- RTSP URLs, usernames, passwords, TLS mode, transport, or output profile.
  Those remain under the existing admin-only Camera Sources workflow.
- `LIVE_STREAM_DURATION_MS`, `LIVE_STREAM_START_TIMEOUT_MS`,
  `LIVE_STREAM_MAX_VIEWERS`, `LIVE_STREAM_RUNTIME_DIR`, RTSP UDP ports, probe
  timeouts, credential keys, or CA files. These advanced settings remain
  environment-backed.
- Installing `cloudflared`, FFmpeg, RTSP runtime assets, or Motion. Existing
  feature installation owns packages and privileged runtime assets.
- Automatically trusting every detected interface.
- Changing the five-minute non-renewable live-session policy.
- A web UI, Telegram Mini App, or arbitrary configuration editor.

## User experience

### Navigation

Admin tools gains a full-width **Live view setup** row. Selecting it begins a
receipt-bound `live-view-settings` workflow whose natural parent is Admin tools.
Non-admins cannot see the row. Every callback and text continuation rechecks the
sender's current role, so demotion immediately invalidates an in-progress draft.

The first screen shows:

- configured state: **Enabled** or **Disabled**;
- active state, including **Restart required** when committed and boot-loaded
  generations differ;
- dependency readiness for `cloudflared` and, when applicable, the RTSP
  runtime;
- the canonical allowed-camera CIDRs, or **None configured**;
- a note that CIDRs are required for enabled RTSP but not for Motion MJPEG.

The controls are:

- **Enable** or **Disable**, never both;
- **Allowed networks**;
- **Back to Admin tools**; and
- **Home**.

The workflow does not report Watch live as ready merely because settings are
valid. Missing packages or unhealthy privileged runtime assets remain a
separate dependency state.

### Allowed networks

Allowed-network editing uses a receipt-bound draft. The admin can:

- select a detected private subnet, labelled with its interface name;
- enter a CIDR manually;
- add more entries;
- remove an entry from the draft; or
- cancel and discard the entire draft.

The draft expires after 10 minutes. Expiry discards it and returns a localized
**Start again** result without touching committed settings.

Detected values are suggestions only. No suggestion is selected or persisted
without an explicit admin action. Callback data contains a bounded opaque
selector, not a raw CIDR or interface name; the receipt-bound draft resolves the
selector server-side.

Manual input accepts IPv4 RFC 1918 networks and IPv6 Unique Local Address
networks. The application:

- trims surrounding whitespace;
- parses the address and prefix;
- zeros host bits without changing the supplied prefix;
- rejects global, loopback, link-local, multicast, and unspecified networks;
- rejects a network that is not wholly contained by `10.0.0.0/8`,
  `172.16.0.0/12`, `192.168.0.0/16`, or `fc00::/7`;
- canonicalizes text representation;
- deduplicates equivalent networks; and
- permits at most 16 entries.

The subnet detector inspects active non-loopback interfaces and returns only
private networks that pass the same domain validation. It may show a virtual
interface, but the interface label makes the choice explicit; the detector does
not rely on a brittle list of interface-name prefixes. No detected result is
persisted merely by opening the screen.

### Enable, disable, and save

Watch live has one global prerequisite gate shared by Motion MJPEG and RTSP.

- Motion-only live view may be enabled with no CIDRs because its upstream is
  loopback-only.
- If the RTSP feature is installed and enabled, enabling Watch live requires at
  least one allowed CIDR.
- RTSP installation or enablement is refused with a localized **Complete Live
  view setup first** result when no allowed CIDR exists.
- Disabling Watch live retains the configured CIDRs so re-enabling does not
  require re-entry. An admin may remove every CIDR while Watch live is disabled.

Every change ends at a review screen. The review shows the new enabled state,
the complete canonical CIDR list, and the warning that current live viewing will
end and the worker will restart. Only **Save & restart** mutates configuration.
Cancel, Back, an expired receipt, a stale callback, or a lost draft leaves
committed settings unchanged.

## Settings model

The camera bounded context owns a pure `LiveViewSettings` value with this
external representation:

```json
{
  "version": 1,
  "generation": 4,
  "enabled": true,
  "allowedCameraCidrs": ["192.168.1.0/24", "fd12:3456:789a::/64"]
}
```

`generation` is a non-negative safe integer. A successful mutation increments
it by exactly one. The file contains no timestamp, user ID, chat ID, receipt ID,
credential, hostname, or advanced tuning value.

The production authority is:

```text
/var/lib/home-worker/live-view-settings.json
owner root:homeworker
mode  0640
```

The worker may read but may not write the committed file. Absence, unsafe file
metadata, malformed JSON, duplicate keys, unknown keys, an unsupported version,
or an invalid value fails closed: Watch live is inactive and Admin tools shows a
sanitized configuration-repair state.

Development and tests use an in-memory adapter with the same port contract.

## Architecture

### Domain

The camera domain owns:

- `LiveViewSettings`, including CIDR and generation invariants;
- a settings-change value that carries an expected generation; and
- typed errors for invalid CIDR, too many CIDRs, stale generation, unsafe
  settings state, and apply unavailability.

The domain contains no filesystem, network-interface, process, Nest controller,
or grammY dependency.

### Application

The camera application layer exposes the following responsibilities behind
ports:

- read committed settings and the generation loaded at worker boot;
- detect candidate private subnets;
- build and validate a draft;
- coordinate a settings apply;
- publish an apply request and read its result; and
- fence or reopen new live-stream starts.

One coordinator owns the mutation sequence. It serializes settings mutations
with live-stream start/stop work, closes the start gate before stopping pending
or active sessions, and keeps the gate closed until either the old state is
restored or the process restarts. `OpenLiveStreamUseCase` must consult this gate
in addition to feature and dependency readiness.

Telegram invokes application use cases only. It never reads or writes settings
files, enumerates operating-system interfaces, invokes `sudo` or systemd,
constructs privileged requests, or restarts PM2 directly.

### Infrastructure

Infrastructure provides:

- a root-owned-file settings reader;
- an operating-system subnet detector;
- a fixed-schema request/result spool adapter;
- a systemd controller for the fixed applier unit;
- a boot reconciliation adapter; and
- in-memory equivalents for use-case tests.

The existing process-restarter port remains the only application-facing way to
request the PM2 restart.

## Privileged apply boundary

### Fixed assets and paths

The installer owns these production assets:

```text
/usr/lib/home-worker/live-view-settings-applier
/usr/lib/home-worker/systemd/homeworker-live-view-settings-apply.service
/var/lib/home-worker/live-view-settings-requests/
/var/lib/home-worker/live-view-settings-claims/
/var/lib/home-worker/live-view-settings-results/
/run/lock/homeworker-live-view-settings.lock
```

Directory ownership and modes mirror the hardened feature-installer spool:

- requests: `root:homeworker`, `0770`;
- claims: `root:root`, `0700`;
- results: `root:homeworker`, `0770`.

The worker can create a bounded request and read a bounded result. It cannot
read claims, write results, replace the root helper, or choose a helper path.
The only sudo rule starts the exact fixed systemd unit with `--no-block`.

The helper and unit are included in the root-bundle integrity manifest and the
privileged-helper version gate. Installation and signed OTA update paths must
install or upgrade them before application code may publish the new request
version.

### Request schema

Each request is a mode-`0600` regular file whose name is the 16-character
base64url request ID plus `.json`. It is bounded to 4 KiB and contains exactly:

```json
{
  "version": 1,
  "requestId": "AbCdEfGhIjKlMnOp",
  "expectedGeneration": 3,
  "settings": {
    "enabled": true,
    "allowedCameraCidrs": ["192.168.1.0/24"]
  }
}
```

The root helper accepts no paths, commands, environment keys, shell fragments,
user IDs, chat IDs, hostnames, URLs, or credentials. It reopens the request with
`O_NOFOLLOW`, validates exact ownership, link count, mode, size, filename,
schema, CIDRs, and expected generation, then normalizes the claimed file to
root ownership before acting.

Only one request may be active globally. Duplicate publication of the same
canonical request is idempotent. A different request with a stale expected
generation returns `stale-generation` without changing either authority.

### Policy correlation and commit order

When RTSP runtime assets are installed, the root policy advances to a strict
version that includes `settingsGeneration`. An empty `allowedCidrs` array is a
valid deny-all policy, which is required when Watch live or RTSP is disabled.
The network helper continues to reject every address that is not contained by
an allowed CIDR.

The policy uses this exact version-2 shape; the network helper rejects missing,
duplicate, or additional keys:

```json
{
  "version": 2,
  "settingsGeneration": 4,
  "workerUid": 1001,
  "streamUid": 997,
  "allowedCidrs": ["192.168.1.0/24"],
  "udpPortFirst": 24000,
  "udpPortLast": 24001
}
```

For generation `N + 1`, the applier:

1. acquires the dedicated non-blocking lock;
2. validates the current settings generation is `N`;
3. validates and canonicalizes the entire candidate;
4. writes and fsyncs the root RTSP policy for `N + 1`, when RTSP assets exist;
5. restarts the restricted egress helper so old leases and rules are removed;
6. verifies the policy is readable and the service is healthy;
7. writes and fsyncs the committed settings file for `N + 1`;
8. fsyncs both parent directories; and
9. writes a bounded terminal result.

The settings-file rename is the commit point. A crash before it leaves the old
settings authoritative. A policy/settings generation mismatch makes RTSP
readiness fail closed. The claimed request remains replayable; replay recognizes
an already-written candidate policy and finishes the same generation rather
than incrementing again.

When RTSP assets are absent, there is no policy write. The helper still validates
and commits the settings file. Later RTSP installation consumes the committed
settings and creates a policy with the same generation.

The result contains exactly `version`, `requestId`, `outcome`,
`resultingGeneration`, and `failureCode`. `outcome` is `succeeded` or `failed`.
`resultingGeneration` is the committed generation on success and `null` on
failure. `failureCode` is `null` on success or one of:

- `request-invalid`;
- `stale-generation`;
- `settings-state-unsafe`;
- `policy-apply-failed`;
- `service-unhealthy`;
- `interrupted`; or
- `helper-version-mismatch`.

The result never includes child-process output or raw configuration text.

## Apply and restart flow

1. The admin opens the workflow at committed generation `N`.
2. Telegram maintains a receipt-bound draft and records `N` as its expected
   generation.
3. On **Save & restart**, the handler rechecks the current admin role and claims
   the exact receipt.
4. The camera application coordinator closes the start gate and stops all
   starting or active live-stream work. Failure to stop aborts before request
   publication.
5. The application claims the receipt with a durable operation containing
   exactly `kind: live-view-settings-mutation`, the request ID, and expected
   generation; it then publishes the request and starts the fixed applier unit.
   Telegram immediately shows **Applying live view settings…**.
6. The helper applies or rejects the request and writes a terminal result.
7. On failure, the application reports a localized outcome and reopens the old
   gate only after confirming the committed generation is still `N`.
8. On success, the application records a durable restart outcome, sends the
   best-effort **Saved — restarting** message, and invokes the existing process
   restarter.
9. After boot, reconciliation compares the settings generation, policy
   generation when RTSP is installed, dependency readiness, and the pending
   workflow operation. It opens the gate only when the committed configuration
   is enabled and ready, then delivers the localized terminal result through the
   existing receipt-bound recovery mechanism.

The workflow receipt already carries the user/chat boundary. The root spool
therefore carries only the opaque request ID as its correlation identity; chat
IDs are neither copied into privileged files nor logged.

The new operation extends the existing workflow-receipt JSON union and requires
no database migration. It is valid only when the workflow discriminator is
`live-view-settings`. The receipt repository validates its exact keys and the
same request-ID and generation bounds as the privileged request.

The applier unit has a 60-second total timeout and uses shorter bounded timeouts
for each filesystem or systemd operation. Result reconciliation is independent
of the Telegram handler lifetime: a timeout, worker exit, or navigation away
leaves the durable operation recoverable and never causes an unbounded wait in
the bot update queue.

If settings commit succeeds but PM2 restart dispatch fails, the active process
continues with generation `N`, the committed file remains at `N + 1`, and the
start gate stays closed. The admin receives **Saved — restart required** with a
retry action. Opening Live view setup also displays configured generation
`N + 1` versus active generation `N`. A later successful restart activates the
committed state; no second settings mutation is created.

A Telegram delivery failure never rolls back a committed configuration or
prevents a confirmed restart. Durable recovery attempts the result after boot.

## Feature and installer interaction

The typed file is authoritative for only `enabled` and
`allowedCameraCidrs`. Runtime composition and the RTSP probe stop reading
`LIVE_STREAM_ENABLED` and `RTSP_ALLOWED_CIDRS` after migration. Advanced
environment settings retain their existing readers.

Fresh installation creates generation `0`, disabled, with an empty CIDR list.
The application can start, an administrator can be claimed, and Live view setup
can then be completed before RTSP installation. Selecting RTSP during initial
setup without CIDRs produces a recoverable **Live view setup required** state,
not a generic partially installed success.

On upgrade, the installer creates the typed file only when it is absent:

- `LIVE_STREAM_ENABLED=true` seeds `enabled: true`; every other value seeds
  `false`.
- A valid comma-separated `RTSP_ALLOWED_CIDRS` seeds the canonical list.
- An invalid legacy value fails the migration closed and records a repair state;
  it is never silently broadened or replaced.

Once the typed file exists, later environment edits do not override it. The
legacy keys may remain for one compatibility release but are ignored by the
application and privileged policy generator, then can be removed in a later
cleanup.

RTSP install/enable checks the committed settings before starting privileged
work. It requires at least one CIDR when RTSP will be enabled. The install
routine reads the typed file, generates the matching policy generation, and
retains existing advanced UDP-port configuration. Motion-only live view never
requires camera-network egress, but it still reports a missing `cloudflared`
binary as a dependency problem rather than a settings problem.

## Error handling

All interface errors are localized and sanitized.

| Condition | Outcome |
|---|---|
| Invalid manual CIDR | Keep the draft and identify the invalid entry. |
| More than 16 CIDRs | Keep the draft and request removal before save. |
| No detected subnet | Offer manual entry; do not treat it as an error. |
| Current role is no longer admin | Discard the draft and return the admin-required result. |
| Expected generation is stale | Do not apply; discard the stale draft and reload current settings. |
| Live session cannot be stopped | Do not publish; retain committed settings and report retry. |
| Request cannot be published or unit cannot start | Retain committed settings and reopen the old gate. |
| Helper validation or policy activation fails | Retain committed settings; return a sanitized failure code. |
| Helper crashes after policy write | RTSP remains fenced by generation mismatch; replay the claim. |
| Settings commit succeeds but restart dispatch fails | Keep the gate closed and report **Saved — restart required**. |
| Boot finds unsafe or corrupt settings | Fail closed and show configuration repair required. |
| Boot finds mismatched RTSP policy generation | Fail closed, alert admins, and replay/reconcile the exact request. |
| Dependency is absent after restart | Keep settings, leave Watch live unavailable, and identify the sanitized prerequisite. |
| Telegram result delivery fails | Preserve committed state and retry through durable workflow recovery. |

Raw helper output, file contents, URLs, hostnames, tokens, credentials, stack
traces, chat IDs, and environment contents are never user-facing or logged.

## Concurrency and lifecycle rules

- There is one global settings mutation and one global live stream at a time.
- The expected-generation compare-and-swap prevents concurrent admins from
  overwriting each other.
- The start fence is acquired before stream shutdown, eliminating a stop/start
  race during apply.
- Disable and CIDR changes stop both Motion and RTSP sessions because the
  prerequisite gate is global.
- The fence remains closed across committed-but-not-restarted state.
- Normal worker shutdown still performs existing live-session cleanup.
- Returning Home or Back after the apply begins does not cancel privileged work
  or reopen the gate.
- Duplicate callbacks and duplicate helper starts are idempotent.

## Localization and callback safety

All new labels, summaries, confirmations, validation errors, progress messages,
and recovery outcomes exist in English, Russian, and Ukrainian catalogues with
parity tests. No user-facing text is hardcoded in handlers.

Home callback data gains only a short action code for Live view setup. Workflow
callbacks use the existing 16-character receipt ID plus bounded phase/action
codes. Detected networks and draft entries use receipt-local selectors. Every
callback remains within Telegram's 64-byte UTF-8 limit and contains no CIDR,
interface name, generation, role, or privileged operation.

## Verification

### Domain tests

- Canonicalize IPv4 and IPv6 CIDRs without changing their prefixes.
- Accept only RFC 1918 and ULA networks.
- Reject global, loopback, link-local, multicast, unspecified, and malformed
  input.
- Deduplicate equivalent entries and enforce the 16-entry limit.
- Enforce exact generation increments and stale-generation errors.

### Application tests

- Build drafts from committed settings without mutating the authority.
- Require CIDRs for enabled RTSP but not Motion-only live view.
- Retain CIDRs on disable and allow an empty list while disabled.
- Fence starts before stopping a current or starting session.
- Publish only after successful shutdown.
- Reopen the old gate after a pre-commit failure.
- Keep the gate closed after commit and through restart-required recovery.
- Reject concurrent stale admin saves.
- Reconcile success, helper failure, mismatch, restart failure, and dependency
  failure deterministically.

### Infrastructure and security tests

- Atomic root-owned settings reads with exact owner, group, mode, link, size,
  and schema checks.
- Atomic request publication and exact duplicate behavior.
- Request/claim/result directory validation and `O_NOFOLLOW` handling.
- Helper rejection of duplicate/unknown keys, oversized values, unsafe files,
  filename mismatches, stale generations, invalid CIDRs, extra arguments, and
  untrusted environment/path overrides.
- Policy-before-settings ordering, parent-directory fsync, commit-point
  behavior, interrupted-claim replay, and generation mismatch fail-closed
  behavior.
- Empty deny-all policy behavior.
- Exact systemd unit and sudo command boundaries.
- Root-bundle manifest and privileged-helper version checks.
- No real `sudo`, PM2, nftables, systemd, Cloudflare, or Telegram calls in CI.

### Telegram tests

- Admin-only visibility and entry from Admin tools.
- Current-role checks on every callback and text continuation.
- Status rendering for disabled, enabled, restart-required, dependency-missing,
  and repair-required states.
- Detected and manual CIDR selection, multiple entries, removal, normalization,
  confirmation, Cancel, Back, expiry, and stale callbacks.
- Exact Save & restart warning and post-boot outcomes.
- English/Russian/Ukrainian catalogue parity.
- Callback-size and opaque-selector assertions.

### Installer and composition tests

- Fresh install creates generation `0` disabled settings.
- Upgrade seeds once from valid legacy values and fails closed on invalid ones.
- Existing typed settings always win over legacy environment keys.
- Runtime prerequisite readers use the typed settings while advanced tunables
  remain environment-backed.
- RTSP install consumes the committed generation and refuses missing CIDRs.
- Motion-only settings do not require CIDRs.

### Manual Raspberry Pi acceptance

On a target Pi with a disposable camera and Telegram test bot:

1. Enable Motion-only live view without CIDRs and verify readiness is determined
   separately from settings.
2. Add one detected and one manual CIDR, restart, and verify canonical display.
3. Start a stream, change CIDRs, and verify the stream ends before policy apply.
4. Configure and open an RTSP source inside the allowed network.
5. Verify a source outside the allowed networks is rejected.
6. Disable Watch live during an active session and verify no new start wins the
   race.
7. Force helper validation failure and confirm old settings remain active.
8. Interrupt the helper between policy and settings writes and verify replay and
   fail-closed readiness.
9. Force PM2 restart dispatch failure and verify **Saved — restart required**,
   then retry restart and verify activation.
10. Reboot with a pending terminal result and verify exactly one localized
    recovery outcome.

## Acceptance criteria

- An administrator can enable or disable Watch live from Admin tools.
- An administrator can save one or more canonical private camera CIDRs from
  detected suggestions or manual input.
- Motion-only enablement does not require CIDRs; enabled RTSP does.
- A confirmed mutation stops active live work, applies through the fixed
  privileged boundary, and restarts the worker.
- Concurrent edits cannot overwrite newer settings.
- Unsafe files, invalid requests, crashes, policy mismatches, and restart
  failures all fail closed without broadening camera egress.
- The committed typed file is the sole authority for the two prerequisite
  settings after migration.
- Existing Camera Sources, advanced live-stream tuning, feature installation,
  and five-minute session behavior retain their current ownership.

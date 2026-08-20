# Admin Live View Settings — Design

## Status

Approved during brainstorming on 2026-08-13 and revised after an engineering
pressure test on the same date. This document is the design authority for an
admin-only Telegram workflow that configures the prerequisites for **Watch
live**. It does not implement the feature.

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
- A durable single-active settings-mutation job.
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

Detected suggestions are canonicalized, deduplicated by network, and sorted by
address family, prefix length, network address, and interface label. Multiple
interfaces reporting the same network are rendered as one suggestion with a
bounded joined label. The detector retains at most 32 suggestions and renders
eight per page with receipt-bound Previous and Next controls. Truncation is
explicitly disclosed and manual entry remains available on every page.

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

If host bits were present, the workflow does not silently add the broader
canonical network. It shows the entered value and canonical network and requires
an explicit **Add canonical network** confirmation. Input already at its network
address is added directly to the draft.

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
  view setup first** result when no allowed CIDR exists. The result includes a
  receipt-bound **Open Live view setup** action.
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

Tests use an in-memory adapter with the same port contract. Development uses the
same adapter together with a development-only restart adapter that atomically
promotes the committed generation to the simulated boot-loaded generation. This
lets **Save & restart** complete without invoking PM2 while preserving the same
configured-versus-active semantics.

### Durable mutation job

Settings mutation recovery is not stored only in a per-admin workflow receipt.
SQLite owns a `live_view_settings_jobs` table with:

| Column | Purpose |
|---|---|
| `id` | The 16-character request ID and primary key. |
| `status` | `prepared`, `published`, `committed`, `restart-required`, `succeeded`, or `failed`. |
| `active_slot` | `1` from `prepared` through `restart-required`; `NULL` only after terminalization. A unique index enforces one global active job. |
| `expected_generation` | The committed generation observed during review. |
| `candidate_settings` | Canonical JSON containing only `enabled` and `allowedCameraCidrs`. |
| `requested_by_user_id` | Current admin identity for durable result routing; never logged. |
| `requested_in_chat_id` | Private delivery destination; never logged. |
| `workflow_receipt_id` | The exact `live-view-settings` receipt. |
| `failure_code` | A bounded failure code or `NULL`. |
| `created_at`, `updated_at` | Unix epoch timestamps. |

The unique active slot is the durable global serialization authority. Immediately
before claiming, **Save & restart** fresh-reads the root-owned settings authority
and rejects the draft unless its generation matches the expected generation.
One SQLite immediate transaction then rechecks the current admin, claims the
exact pending workflow receipt, rejects an active RTSP feature-install job, and
inserts the `prepared` job with that expected generation and the full canonical
candidate. The root applier repeats the generation comparison as the final
filesystem compare-and-set. A busy slot, active RTSP installation, stale
generation, expired receipt, role loss, or receipt mismatch changes nothing.
RTSP install/enable/disable performs the reciprocal active-settings-job check
before policy or feature-state mutation. The receipt operation stores exactly
`kind: live-view-settings-mutation`, job ID, and expected generation; the job,
not the receipt, owns the recoverable candidate.

Job `failure_code` is `NULL` until attention is required, then one of the root
result codes or `live-work-not-quiescent`, `request-publish-failed`,
`unit-start-failed`, `restart-dispatch-failed`, `restart-activation-timeout`,
`dependency-unready`, or `interrupted`. No adapter exception text is persisted.

`prepared`, `published`, `committed`, and `restart-required` jobs remain active
across worker exits. Boot reconciliation resumes or terminalizes the exact job
before accepting another settings mutation. A successful boot at the candidate
generation marks the job `succeeded`, clears `active_slot`, and completes the
receipt delivery. A pre-commit failure marks it `failed` and clears the slot.

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
- create and reconcile the durable single-active mutation job;
- coordinate a settings apply;
- publish an apply request and read its result; and
- fence or reopen new live-stream starts.

One policy-mutation coordinator owns the process-local sequence shared by live
view settings mutations and RTSP install/enable/disable lifecycle work. The
durable job active slot serializes settings mutations across process exits; the
root policy lock serializes every privileged policy writer. After a settings
commit, the coordinator enters a restart-pending latch and rejects rather than
queues another settings or RTSP-state mutation until the process restarts.

The coordinator closes a global live-view start gate before quiescing the
session service and keeps it closed until either the old state is safely restored
or the process restarts. Quiescence succeeds only when there is no active
session, pending or replacement start, late-start cleanup, blocked teardown, or
outstanding lease mutation. A bounded timeout or uncertain teardown aborts
before request publication and leaves the gate closed until reconciliation.
`OpenLiveStreamUseCase` and every join/start path inside
`LiveStreamSessionService` consult this global gate in addition to the existing
RTSP feature gate and dependency readiness.

Telegram invokes application use cases only. It never reads or writes settings
files, enumerates operating-system interfaces, invokes `sudo` or systemd,
constructs privileged requests, or restarts PM2 directly.

### Infrastructure

Infrastructure provides:

- a root-owned-file settings reader;
- an operating-system subnet detector;
- a Drizzle durable settings-job repository;
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
/usr/lib/home-worker/live-view-policy-applier
/usr/lib/home-worker/systemd/homeworker-live-view-policy-apply.service
/etc/systemd/system/homeworker-live-view-policy-apply.service
/var/lib/home-worker/live-view-settings-requests/
/var/lib/home-worker/live-view-settings-claims/
/var/lib/home-worker/live-view-settings-results/
/var/lib/home-worker/live-view-settings-acks/
/run/lock/homeworker-live-view-policy.lock
```

Directory ownership and modes separate worker publication, root-only claims,
root-written results, and worker acknowledgements:

- requests: `root:homeworker`, `0770`;
- claims: `root:root`, `0700`;
- results: `root:homeworker`, `0750`; and
- acknowledgements: `root:homeworker`, `0770`.

The worker can create a bounded request and read a bounded result. It cannot
read claims, create, replace, rename, or unlink result entries, replace the root
helper, or choose a helper path. After the matching database transition commits,
the worker may publish a mode-`0600` acknowledgement named for the request ID.
It then best-effort retriggers the same fixed unit so the helper can validate the
worker-owned acknowledgement and remove the matching root-owned terminal result.
An acknowledgement is durable, so a failed cleanup trigger is retried by boot
reconciliation or the next fixed-unit run. The only sudo rule starts the exact
fixed systemd unit with `--no-block`.

The helper, bundled unit, and active `/etc/systemd/system` unit are included in
the root-bundle integrity/version gate. Validation requires the active unit to
be root-owned mode `0644` and byte-identical to the bundled unit. Installation
and signed OTA update paths install both copies atomically, run `systemctl
daemon-reload`, and validate them before application code may publish the new
request version.

### Request schema

Each request is a mode-`0600` regular file whose name is the 16-character
base64url request ID plus `.json`. It is bounded to 4 KiB. A settings mutation
contains exactly:

```json
{
  "version": 1,
  "kind": "settings-mutation",
  "requestId": "AbCdEfGhIjKlMnOp",
  "expectedGeneration": 3,
  "rtspEnabled": true,
  "settings": {
    "enabled": true,
    "allowedCameraCidrs": ["192.168.1.0/24"]
  }
}
```

An RTSP feature-state reconciliation contains exactly:

```json
{
  "version": 1,
  "kind": "rtsp-state-reconcile",
  "requestId": "PqRsTuVwXyZaBcDe",
  "expectedGeneration": 4,
  "rtspEnabled": false
}
```

The root helper accepts no caller-selected paths, commands, environment keys,
shell fragments, user IDs, chat IDs, hostnames, URLs, or credentials. It
reopens the request with `O_NOFOLLOW`, validates exact ownership, link count,
mode, size, filename, discriminated schema, CIDRs, feature-state boolean, and
expected generation, then normalizes the claimed file to root ownership before
acting. Its root-only `--bootstrap-rtsp` mode is invoked only by the fixed RTSP
installation routine; it reads the committed settings and installs a deny-all
policy with `rtspEnabled: false` before the feature can become enabled.

Only one request may be active globally. Duplicate publication of the same
canonical request is idempotent. A different request with a stale expected
generation returns `stale-generation` without changing either authority.

### Policy correlation and commit order

When RTSP runtime assets are installed, the root policy advances to a strict
version correlated by the exact tuple `(settingsGeneration, rtspEnabled)`.
`allowedCidrs` equals the committed CIDR list only when both Watch live and RTSP
are enabled; otherwise it is an empty, valid deny-all list. The network helper
continues to reject every address that is not contained by an allowed CIDR.

The policy uses this exact version-2 shape; the network helper rejects missing,
duplicate, or additional keys:

```json
{
  "version": 2,
  "settingsGeneration": 4,
  "rtspEnabled": true,
  "workerUid": 1001,
  "streamUid": 997,
  "allowedCidrs": ["192.168.1.0/24"],
  "udpPortFirst": 24000,
  "udpPortLast": 24001
}
```

For a settings mutation targeting generation `N + 1`, the policy applier:

1. acquires the shared non-blocking live-view policy lock;
2. validates the current settings generation is `N`;
3. validates and canonicalizes the entire candidate;
4. derives the exact `(N + 1, rtspEnabled)` policy and writes and fsyncs it when
   RTSP assets exist;
5. restarts the restricted egress helper so old leases and rules are removed;
6. verifies the exact policy tuple is readable and the service is healthy;
7. writes and fsyncs the committed settings file for `N + 1`;
8. fsyncs both parent directories; and
9. writes a bounded terminal result.

The settings-file rename is the settings-mutation commit point. A crash before
it leaves the old settings authoritative. A mismatch in either policy tuple
member makes RTSP readiness fail closed. The claimed request remains replayable;
replay recognizes an already-written candidate policy and finishes the same
generation rather than incrementing again.

For an `rtsp-state-reconcile` request, the applier acquires the same lock,
requires the committed generation to equal `expectedGeneration`, derives the
policy from the committed settings and requested boolean, replaces and fsyncs
the policy, restarts the restricted egress helper, and verifies the exact tuple.
It never rewrites or increments the settings file. RTSP install, enable,
disable, boot reconciliation, and settings apply therefore share one policy
writer and one lock.

When RTSP assets are absent, a settings mutation performs no policy write and
still commits the settings file. An RTSP-state reconciliation returns
`rtsp-assets-absent`. Later RTSP installation invokes the fixed bootstrap mode,
which consumes the committed settings and creates a deny-all policy at the same
generation before application-side enablement reconciles `rtspEnabled: true`.

The result contains exactly `version`, `kind`, `requestId`, `outcome`,
`resultingGeneration`, `resultingRtspEnabled`, and `failureCode`. `outcome` is
`succeeded` or `failed`. The resulting tuple members are non-null on success and
both null on failure. `failureCode` is `null` on success or one of:

- `request-invalid`;
- `stale-generation`;
- `settings-state-unsafe`;
- `policy-apply-failed`;
- `service-unhealthy`;
- `rtsp-assets-absent`;
- `interrupted`; or
- `helper-version-mismatch`.

The result never includes child-process output or raw configuration text.

## Apply and restart flow

1. The admin opens the workflow at committed generation `N`.
2. Telegram maintains a receipt-bound draft and records `N` as its expected
   generation.
3. On **Save & restart**, the application fresh-reads committed generation `N`.
   One SQLite immediate transaction then rechecks the current admin role,
   claims the exact receipt, and inserts the globally single-active `prepared`
   job with expected generation `N` and the canonical candidate. The root
   applier repeats the generation check before committing any change.
4. The policy-mutation coordinator closes the global start gate and quiesces all
   starting, active, late-cleanup, and lease-mutation work. Failure or timeout
   terminalizes the job before request publication.
5. The application idempotently publishes the job request, marks the job
   `published`, and starts the fixed policy-applier unit. Telegram immediately
   shows **Applying live view settings…**.
6. The helper applies or rejects the request and writes a terminal result.
7. On pre-commit failure, the application marks the job `failed` and reports a
   localized outcome. It reopens the old gate only after confirming committed
   generation `N`, the old RTSP policy tuple when applicable, and dependency
   readiness. Uncertain cleanup or policy state remains fail-closed.
8. On success, the application verifies generation `N + 1`, marks the job
   `committed`, enters the restart-pending latch, sends the best-effort **Saved —
   restarting** message, and invokes the process restarter.
9. The process-restarter contract acknowledges dispatch only after the fixed PM2
   command exits successfully; a spawn event alone is not success. A bounded
   15-second activation watchdog marks the still-active job `restart-required`
   if the old process remains alive. The latch and global live-view gate remain
   closed, and the retry action dispatches another restart without creating a
   second settings job.
10. After boot, reconciliation compares the committed and boot-loaded settings
    generations, the exact policy tuple when RTSP is installed, durable feature
    state, dependency readiness, and the active job. It opens the global gate
    only when the committed configuration is enabled and ready, marks the job
    `succeeded`, clears its active slot, publishes the result acknowledgement,
    best-effort retriggers the fixed unit for root-owned cleanup, and delivers
    the localized terminal result through the existing receipt-bound recovery
    mechanism.

The workflow receipt already carries the user/chat boundary. The root spool
therefore carries only the opaque request ID as its correlation identity; chat
IDs are neither copied into privileged files nor logged.

The new operation extends the existing workflow-receipt JSON union and is valid
only when the workflow discriminator is `live-view-settings`. The receipt
repository validates its exact keys and the same request-ID and generation
bounds as the privileged request. The durable global job requires a generated
Drizzle migration; migration SQL and metadata are never hand-edited.

The policy-applier unit has a 60-second total timeout and uses shorter bounded timeouts
for each filesystem or systemd operation. Result reconciliation is independent
of the Telegram handler lifetime: a timeout, worker exit, or navigation away
leaves the durable operation recoverable and never causes an unbounded wait in
the bot update queue.

Boot recovery handles every durable phase explicitly. A `prepared` job resumes
quiescence and idempotent publication from its stored candidate. A `published`
job retriggers the fixed unit and reconciles request, claim, result, and
generation state. A `committed` or `restart-required` job never republishes a
settings mutation; it only verifies activation or retries restart. If the unit
is terminal, no request or result exists, and generation remains `N`, recovery
marks the exact job `failed` with `interrupted` and safely restores the old gate.

If settings commit succeeds but PM2 dispatch is rejected, exits non-zero, or
does not replace the process within 15 seconds, the active process continues
with generation `N`, the committed file remains at `N + 1`, and the start gate
and mutation latch stay closed. The admin receives **Saved — restart required**
with a retry action. Opening Live view setup also displays configured generation
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
setup no longer writes `LIVE_STREAM_ENABLED`. The installer defers RTSP instead
of invoking its root routine while no CIDR exists, completes the other selected
features, and renders a specific **Live view setup required — finish in
Telegram** outcome rather than a generic partially installed success. After the
admin saves at least one CIDR, normal Feature management installs RTSP.

On upgrade, the installer creates the typed file only when it is absent:

- `LIVE_STREAM_ENABLED=true` seeds `enabled: true`; every other value seeds
  `false`.
- A valid comma-separated `RTSP_ALLOWED_CIDRS` seeds the canonical list.
- An invalid legacy value is never trusted or broadened. The installer creates a
  valid generation-`0`, disabled, empty authority plus a root-owned, bounded
  `legacy-values-invalid` attention marker containing no legacy value. Admin
  tools explains that legacy settings were not imported and requires review and
  an explicit save; the first successful mutation removes the marker.

An already-existing typed file that later becomes absent, unsafe, or corrupt is
not reset from Telegram because its last valid generation is unknowable. The
worker fails closed and gives sanitized local installer-repair guidance. The
installer repair path validates or deliberately resets the authority to
generation `0`, disabled, empty, and a deny-all policy before restarting the
worker.

Once the typed file exists, later environment edits do not override it. The
legacy keys may remain for one compatibility release but are ignored by the
application and privileged policy generator, then can be removed in a later
cleanup.

RTSP install/enable checks the committed settings before starting privileged
work. It requires at least one CIDR when RTSP will be enabled. The fixed install
routine installs packages and runtime assets, then invokes the policy applier's
root-only bootstrap mode under the shared policy lock. Bootstrap reads the typed
file, creates the version-2 deny-all policy with `rtspEnabled: false`, and
retains existing advanced UDP-port configuration.

After installation or ordinary enable commits durable RTSP feature state, the
registered camera `afterEnable` lifecycle publishes an
`rtsp-state-reconcile` request with `rtspEnabled: true`; it opens the RTSP gate
only after the exact policy tuple is healthy. Before ordinary disable persists
feature state, `beforeDisable` closes the RTSP gate, drains RTSP work, and
reconciles `rtspEnabled: false`. Existing feature compensation restores the
opposite policy tuple when its feature-state compare-and-set fails. Boot
reconciliation repairs any feature-state/policy tuple mismatch before opening
the gate. Motion-only live view never requires camera-network egress, but it
still reports a missing `cloudflared` binary as a dependency problem rather than
a settings problem.

## Error handling

All interface errors are localized and sanitized.

| Condition | Outcome |
|---|---|
| Invalid manual CIDR | Keep the draft and identify the invalid entry. |
| More than 16 CIDRs | Keep the draft and request removal before save. |
| No detected subnet | Offer manual entry; do not treat it as an error. |
| Current role is no longer admin | Discard the draft and return the admin-required result. |
| Another settings mutation is active | Do not claim the receipt; show the current operation state and retry guidance. |
| Expected generation is stale | Do not apply; discard the stale draft and reload current settings. |
| Live work cannot be proven quiescent | Do not publish; retain committed settings, keep the gate closed until reconciliation, and report retry. |
| Request cannot be published or unit cannot start | Retain committed settings and reopen the old gate. |
| Helper validation or policy activation fails | Retain committed settings; return a sanitized failure code. |
| Helper crashes after policy write | RTSP remains fenced by policy-tuple mismatch; replay the claim. |
| RTSP feature state and policy tuple differ | Keep RTSP fenced and reconcile through the single policy writer. |
| Settings commit succeeds but restart dispatch is rejected, exits non-zero, or times out | Keep the gate closed and report **Saved — restart required**. |
| Boot finds unsafe or corrupt settings | Fail closed and show configuration repair required. |
| Boot finds a mismatched RTSP policy tuple | Fail closed, alert admins, and replay/reconcile the exact request. |
| Dependency is absent after restart | Keep settings, leave Watch live unavailable, and identify the sanitized prerequisite. |
| Telegram result delivery fails | Preserve committed state and retry through durable workflow recovery. |

Raw helper output, file contents, URLs, hostnames, tokens, credentials, stack
traces, chat IDs, and environment contents are never user-facing or logged.

## Concurrency and lifecycle rules

- The database active slot permits one global settings mutation and the session
  service permits one global live stream at a time.
- The expected-generation compare-and-swap prevents concurrent admins from
  overwriting each other.
- The process-local policy coordinator and root policy lock serialize settings
  apply with RTSP install/enable/disable work.
- The start fence is acquired before stream quiescence, eliminating stop/start,
  late-start, and join races during apply.
- Disable and CIDR changes stop both Motion and RTSP sessions because the
  prerequisite gate is global.
- The fence remains closed across committed-but-not-restarted state.
- Normal worker shutdown still performs existing live-session cleanup.
- Returning Home or Back after the apply begins does not cancel privileged work
  or reopen the gate.
- Duplicate callbacks and duplicate helper starts are idempotent.
- A committed job holds both the durable active slot and restart-pending latch;
  no second mutation is queued into the shutdown window.

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
- Reject generation overflow at `Number.MAX_SAFE_INTEGER` without mutation.
- Derive allow or deny-all policy content from the exact
  `(settingsGeneration, rtspEnabled)` tuple.

### Application tests

- Build drafts from committed settings without mutating the authority.
- Require CIDRs for enabled RTSP but not Motion-only live view.
- Retain CIDRs on disable and allow an empty list while disabled.
- Atomically claim the receipt and create one globally active `prepared` job.
- Reject a second admin while the active slot is occupied.
- Fence starts before quiescing a current, pending, replacement, late-start, or
  lease-mutation state.
- Publish only after proven quiescence.
- Reopen the old gate after a pre-commit failure.
- Keep the gate closed after commit and through restart-required recovery.
- Reject concurrent stale admin saves.
- Resume `prepared` and `published` jobs after a crash without losing the stored
  candidate or duplicating a generation increment.
- Reconcile success, helper failure, policy-tuple mismatch, PM2 spawn failure,
  PM2 non-zero exit, activation timeout, and dependency failure deterministically.
- Reconcile RTSP enable/disable through the same policy coordinator and restore
  the opposite tuple during feature-state compensation.

### Infrastructure and security tests

- Atomic root-owned settings reads with exact owner, group, mode, link, size,
  and schema checks.
- Atomic request publication and exact duplicate behavior.
- Request/claim/result/acknowledgement directory validation and `O_NOFOLLOW`
  handling.
- Prove the worker cannot create, replace, rename, or unlink entries in the
  mode-`0750` result directory; accept acknowledgements only from the separate
  mode-`0770` acknowledgement directory.
- Helper rejection of duplicate/unknown keys, oversized values, unsafe files,
  filename mismatches, stale generations, invalid CIDRs, extra arguments, and
  untrusted environment/path overrides.
- Policy-before-settings ordering, parent-directory fsync, commit-point
  behavior, interrupted-claim replay, and policy-tuple mismatch fail-closed
  behavior.
- Empty deny-all policy behavior.
- Settings-mutation and RTSP-state-reconcile request-union behavior under one
  shared root lock.
- Exact systemd unit and sudo command boundaries.
- Root-bundle manifest, active-unit byte equality, and privileged-helper version
  checks.
- PM2 adapter waits for command exit and rejects non-zero exit after a successful
  spawn.
- No real `sudo`, PM2, nftables, systemd, Cloudflare, or Telegram calls in CI.

### Telegram tests

- Admin-only visibility and entry from Admin tools.
- Current-role checks on every callback and text continuation.
- Status rendering for disabled, enabled, restart-required, dependency-missing,
  mutation-busy, legacy-import-attention, and repair-required states.
- Detected and manual CIDR selection, multiple entries, removal, normalization,
  explicit host-bit confirmation, suggestion pagination/truncation, Cancel,
  Back, expiry, and stale callbacks.
- Exact Save & restart warning and post-boot outcomes.
- English/Russian/Ukrainian catalogue parity.
- Callback-size and opaque-selector assertions.

### Installer and composition tests

- Fresh install creates generation `0` disabled settings.
- Fresh setup stops writing `LIVE_STREAM_ENABLED` and defers selected RTSP with
  explicit Telegram completion guidance when no CIDR exists.
- Upgrade seeds once from valid legacy values; invalid legacy values create a
  safe generation-`0` authority plus the bounded attention marker.
- Existing typed settings always win over legacy environment keys.
- Runtime prerequisite readers use the typed settings while advanced tunables
  remain environment-backed.
- RTSP install refuses missing CIDRs, bootstraps a deny-all version-2 policy,
  then reconciles `rtspEnabled: true` only after durable feature enablement.
- RTSP disable produces deny-all at the same settings generation and re-enable
  restores the committed CIDRs without a settings mutation.
- Motion-only settings do not require CIDRs.

### Manual Raspberry Pi acceptance

On a target Pi with a disposable camera and Telegram test bot:

1. Enable Motion-only live view without CIDRs and verify readiness is determined
   separately from settings.
2. Add one detected and one manual CIDR, restart, and verify canonical display.
3. Start a stream, change CIDRs, and verify the stream ends before policy apply.
4. Hold gateway startup past its timeout, save settings, and verify no late
   converter survives into policy apply.
5. Configure and open an RTSP source inside the allowed network.
6. Verify a source outside the allowed networks is rejected.
7. Disable and re-enable the RTSP feature without changing settings; verify the
   policy changes deny-all → allow at the same settings generation.
8. Disable Watch live during an active session and verify no new start wins the
   race.
9. Submit saves from two admins and verify only one durable active job exists.
10. Force helper validation failure and confirm old settings remain active.
11. Interrupt the helper between policy and settings writes and verify replay and
   fail-closed readiness.
12. Force PM2 spawn failure, non-zero command exit, and activation timeout; each
    must show **Saved — restart required** without a second mutation.
13. Retry restart and verify activation.
14. Reboot with `prepared`, `published`, and pending terminal-result jobs and
    verify one deterministic localized recovery outcome for each phase.

## Acceptance criteria

- An administrator can enable or disable Watch live from Admin tools.
- An administrator can save one or more canonical private camera CIDRs from
  detected suggestions or manual input.
- Motion-only enablement does not require CIDRs; enabled RTSP does.
- A confirmed mutation stops active live work, applies through the fixed
  privileged boundary, and restarts the worker.
- Concurrent edits cannot overwrite newer settings.
- One durable active slot prevents a second mutation from entering the restart
  window.
- Unsafe files, invalid requests, crashes, policy mismatches, and restart
  failures all fail closed without broadening camera egress.
- RTSP install/enable/disable and settings apply use one policy writer, one root
  lock, and an exact policy tuple.
- The committed typed file is the sole authority for the two prerequisite
  settings after migration.
- Existing Camera Sources, advanced live-stream tuning, feature installation,
  and five-minute session behavior retain their current ownership.

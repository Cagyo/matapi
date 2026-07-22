# Telegram Feature Management Design

**Date:** 2026-07-22

**Status:** Revised after pressure test; proposed for user review

**Scope:** Interactive Telegram feature discovery, install, enable, disable, runtime gating, restart disclosure, recovery, localization, and tests

**Supersedes:** The runtime-install restriction in `docs/specs/17-bot-cmd-feature.md` and the matching feature-install notes in `docs/specs/25-install.md`. Those numbered specs are updated with this design.

## Summary

Telegram gains an admin-only **Features** workflow under **Admin tools**. It lists the five supported features—Digital, UART/CO₂, Zigbee, Motion, and RTSP—with their installed, enabled, and attention state. Selecting a feature shows its impact and exactly one valid mutation: **Install & enable**, **Enable**, or **Disable**.

The design deliberately separates two kinds of work:

- **Enable and disable** remain ordinary application use cases. They change feature state, stop or gate affected runtime work, and use the existing worker restart path.
- **Install** may change packages, groups, services, or boot configuration, so it runs through one fixed root-owned helper and one durable install job.

Every mutation requires a current administrator in a private chat and an exact action-specific confirmation. The existing durable workflow-return receipt owns navigation and outcome delivery. Telegram delivery never determines whether an install job is terminal.

## Goals

- Make feature discovery and state understandable without typed commands.
- Install missing dependencies through a narrow privileged boundary.
- Enable or disable installed features without routing ordinary toggles through root.
- Stop disabled feature work and hide its controls.
- Verify readiness before exposing operational controls.
- Recover a running installation after worker or host restart.
- Never let notification failure block later feature management.
- Never uninstall packages when disabling a feature.
- Keep direct commands and buttons on one localized workflow.

## Non-goals

- Implementing Neobox or 4G support.
- Building a general package manager, terminal, arbitrary command runner, or sudo broker.
- Installing or configuring a Zigbee coordinator or Zigbee2MQTT. Zigbee installation covers the currently supported Mosquitto/MQTT dependency only.
- Supporting simultaneous dependency installations.
- Rolling back apt transactions or removing partially installed packages.
- Dynamically unloading Nest modules.
- Guaranteeing exactly-once Telegram delivery. Recovered outcomes are at-least-once and duplicate-safe.
- Adding a second administrator credential. If a future threat model requires protection from a compromised Telegram administrator account, that is a separate design.

## Product decisions

1. Feature management lives at **Home → More → Admin tools → Features**.
2. The selector is one flat list of five full-width buttons.
3. `neobox` and `4g` are hidden from setup and Telegram feature management.
4. Only enabled, ready features contribute operational controls.
5. Every operational entry point rechecks feature availability before doing work.
6. Every mutation uses an action-specific confirmation; generic **Confirm** is not used.
7. Direct `/feature` mutations enter the same detail and confirmation flow as buttons.
8. Enable and disable use the existing application path and worker restarter.
9. Only install uses the root helper.
10. Disable never uninstalls packages.
11. A failed or uncertain install releases the global install slot and marks only the affected feature **Needs attention**.
12. Operation completion and Telegram notification delivery are independent.

## Product vocabulary

| Canonical name | Primary label | Description |
|---|---|---|
| `digital` | Digital inputs | GPIO-based contact, alarm, leak, power, motion, and button sensors |
| `uart` | CO₂ sensor | Serial/UART CO₂ monitoring |
| `zigbee` | Zigbee devices | Existing MQTT-backed sensors and the local Mosquitto dependency |
| `motion` | Motion camera | Motion detection, snapshots, recorded events, and Motion daemon controls |
| `rtsp` | Live camera streams | RTSP source setup and on-demand live streaming |

Environment variables, systemd, sudo, PM2, receipts, and spool files do not appear in normal Telegram copy.

## Feature states and actions

| Persisted state | Display | Detail action |
|---|---|---|
| `installed=false`, `enabled=false` | `⬇ Not installed` | **Install & enable** |
| `installed=true`, `enabled=false` | `⏸ Installed · off` | **Enable** |
| `installed=true`, `enabled=true` | `✅ Enabled` | **Disable** |
| Any state with `attention_reason != null` | `⚠ Needs attention` | **Verify again** or local guidance |

`enabled=true` with `installed=false` is inconsistent. It contributes no operational controls and is shown as **Needs attention**.

An active install is shown as `⏳ Installing…`. It blocks another install and all mutations of the same feature, but it does not make unrelated features unavailable.

The detail screen shows:

- feature label and current state;
- required or verified dependencies;
- controls that will appear or disappear;
- monitoring or camera impact;
- expected downtime and restart scope;
- the one valid action.

Confirmation labels name the effect:

- **Install Motion camera & restart**
- **Enable Digital inputs & restart**
- **Disable Live camera streams & restart**
- **Install CO₂ sensor & reboot Pi** when UART configuration requires a host reboot

## Authorization and workflow

Only a currently authorized administrator in a private chat may mutate features.

For every mutation:

1. Begin or reuse the existing durable workflow-return receipt.
2. Validate the feature and expected current state.
3. Render the impact and exact confirmation label.
4. On confirmation, atomically claim the receipt and recheck the current role.
5. Invoke the matching application use case.

A stale, duplicate, expired, mismatched, or superseded callback has no effect and returns an authorized recovery destination.

There is no `FEATURE_ADMIN_SECRET`, approval-code prompt, cooldown, setup disclosure, or secret-rotation script in this slice. Telegram account hardening and administrator role management remain the authentication boundary.

## Direct commands

```text
/feature list
/feature install <name>
/feature enable <name>
/feature disable <name>
```

`/feature list` opens the localized interactive list. Mutation commands open the same detail and confirmation flow as buttons; they never call a mutating use case directly.

If the typed action is invalid for the current state, Telegram opens the detail screen with the one valid action. `neobox`, `4g`, and unknown names receive localized unavailable-feature copy without enumerating hidden entries.

## Operational feature gates

Feature flags must govern runtime work, not only menu visibility.

The features context exports a `FeatureAvailabilityPort` that answers whether a feature is installed, enabled, ready, and free of an active same-feature installation. Consumers use that port at application boundaries.

| Feature | Runtime and UI gate |
|---|---|
| `digital` | Digital sensor creation and active digital drivers |
| `uart` | UART sensor creation and active UART drivers |
| `zigbee` | MQTT-backed sensor creation and active MQTT drivers |
| `motion` | Motion dashboard actions, watcher work, and daemon controls |
| `rtsp` | RTSP source management and live-stream start |

Required behavior:

- `SensorRegistryService` filters boot and reload candidates through feature availability.
- Disabling Digital, UART, or Zigbee tears down active drivers of the mapped sensor type, then persists the disabled flag.
- Disabling Motion stops feature-owned watcher/runtime work and the Motion daemon through its existing fixed control port.
- Disabling RTSP closes the start gate and stops active RTSP sessions through the existing lifecycle.
- Every camera and sensor callback rechecks feature availability immediately before invoking its effect.
- A worker restart reconstructs runtime gates from persisted feature state.
- Fresh menus omit unavailable controls; stale controls explain the disabled or attention state.

This extends the existing disable-lifecycle registry with concrete lifecycles for all five supported features. It does not attempt dynamic Nest module unloading.

## Architecture

The work extends the existing `features` bounded context and preserves the repository's hexagonal dependency rule.

### Domain

Add or refine pure types for:

- available versus legacy catalog features;
- feature action (`install`, `enable`, `disable`, `verify`);
- readiness and safe attention reasons;
- install-job state and allowlisted failure categories;
- feature unavailable, inconsistent, busy, and verification errors.

### Application

Keep the application surface small:

- **ListManageableFeaturesUseCase** merges the available catalog with persisted state and active install state.
- **GetFeatureDetailUseCase** derives the one valid action, impact, and restart disclosure.
- **EnableFeatureUseCase** verifies installed readiness, changes the flag, reloads affected runtime work, and requests a worker restart when required.
- **DisableFeatureUseCase** runs the registered teardown, changes the flag, and requests a worker restart when required.
- **BeginFeatureInstallUseCase** atomically validates expected state and creates one queued install job.
- **ReconcileFeatureInstallUseCase** consumes the root result, verifies application-visible readiness, applies feature state, terminalizes the job, and stages restart metadata.
- **VerifyFeatureReadinessUseCase** verifies an enabled feature on boot, before mutation, after installation, and on **Verify again**.

Use cases depend on ports, not Drizzle, grammY, filesystem APIs, `child_process`, or concrete system adapters.

### Infrastructure

Infrastructure provides:

- Drizzle feature and install-job repositories;
- atomic request publisher and bounded result reader;
- one fixed systemd job controller;
- per-feature application-visible verifiers;
- existing process-restarter and fixed supervisor/host restart adapters;
- in-memory repositories and adapters for tests.

### Telegram interface

The feature handler:

- registers command and callback grammars;
- invokes existing role middleware and workflow-return coordination;
- renders localized list, detail, confirmation, progress, recovery, and stale-control copy;
- maps typed errors to locale keys;
- delegates every effect to application use cases.

The existing workflow-return receipt remains the durable authority for user ID, chat ID, receipt ID, origin, running phase, and delivery stage. The feature install row references that identity rather than inventing a second notification protocol.

## Privileged installation boundary

Only dependency installation crosses this boundary.

### Root-owned artifacts

```text
/usr/lib/home-worker/feature-installer
/etc/systemd/system/homeworker-feature-install.service
/etc/systemd/system/homeworker-feature-supervisor-restart.service
/etc/systemd/system/homeworker-feature-host-reboot.service
/var/lib/home-worker/feature-install-requests/
/var/lib/home-worker/feature-install-results/
```

The helper and units are root-owned and not writable by the worker. The worker may start only the exact fixed units and cannot supply a command, package, path, environment assignment, alternate unit, or shell fragment through sudo.

The request schema is intentionally small:

```ts
interface FeatureInstallRequestV1 {
  version: 1;
  jobId: string;
  feature: 'digital' | 'uart' | 'zigbee' | 'motion' | 'rtsp';
}
```

The helper:

1. obtains a global `flock`;
2. atomically moves the selected request into a root-only claim directory;
3. opens it with no-follow semantics and validates size, type, ownership, mode, link count, ID, keys, and feature;
4. reads and parses from that same descriptor;
5. runs one fixed per-feature routine without caller-controlled shell text;
6. performs privileged postcondition checks;
7. atomically writes a root-owned bounded result.

The result contains only job ID, feature, success or failure, allowlisted failure category, privileged verification outcome, and required restart scope. Raw apt output, URLs, credentials, environment values, and arbitrary stderr remain in the system journal and never enter SQLite or Telegram.

Existing `scripts/install-feature.sh` behavior may be reused only after its routines are installed as a root-owned artifact and invoked with an allowlisted feature selected by the helper. The worker must never execute the repository copy with root privileges.

## Durable install jobs

Add a `feature_install_jobs` table with:

| Column | Purpose |
|---|---|
| `id` | Canonical bounded job identifier |
| `feature_name` | Available feature |
| `status` | `queued`, `running`, `succeeded`, or `failed` |
| `active_slot` | `1` only while queued or running; otherwise null |
| `requested_by_user_id` | Requesting user; never logged |
| `requested_in_chat_id` | Private delivery destination; never logged |
| `workflow_receipt_id` | Existing workflow-return receipt identity |
| `previous_installed` | Expected-state snapshot |
| `previous_enabled` | Expected-state snapshot |
| `restart_scope` | Worker, supervisor, host, or null |
| `failure_code` | Allowlisted safe category or null |
| `created_at` / `updated_at` | Unix epoch integers |

A unique index on `active_slot` enforces one active installation. Both terminal states clear it. `attention_reason` lives on the affected feature row, not on the global job lock.

Allowed transitions are deliberately small:

```text
queued → running → succeeded
                 ↘ failed
queued ───────────→ failed
```

Telegram delivery does not appear in this state machine.

## Install and recovery flow

1. Claim the exact confirmation receipt and recheck the administrator role.
2. In one immediate transaction, verify expected feature state and create the queued job.
3. Publish the bounded request and start the fixed install unit.
4. Mark the job running after the unit accepts it.
5. Reconcile the matching result during normal execution and on every worker boot.
6. On privileged success, independently verify application-visible readiness.
7. In one transaction, set `installed=true`, `enabled=true`, clear attention, mark the job succeeded, clear the active slot, and stage the restart reason/job identity.
8. Send the pre-restart notice best-effort and invoke the disclosed restart.
9. After boot, verify readiness and deliver the recovered outcome through the existing workflow receipt.

If request publication or helper execution fails, the job becomes failed and clears the active slot. A safe failure before external changes leaves the feature unchanged and permits a fresh install attempt. If previous readiness is provable after partial work, previous feature flags remain. If neither previous nor desired readiness is provable, only that feature receives an allowlisted attention reason and contributes no controls.

**Verify again** performs verification only. It never reruns package installation automatically.

If restart dispatch fails after a successful installation, the job remains terminal. The feature is marked **Needs attention: restart required**, Telegram provides local restart guidance, and unrelated feature management remains available.

The workflow receipt enters its existing running phase before helper submission and remains recoverable until the install job is terminal. Recovered Telegram outcomes are at-least-once. Copy includes the feature and final state so a duplicate is harmless. A failed send remains pending in the existing receipt delivery state but never reopens or blocks the install job.

## Enable and disable flow

Enable and disable do not create install jobs or invoke the root install helper.

### Enable

1. Claim confirmation and recheck role.
2. Verify `installed=true` and feature readiness.
3. Atomically set `enabled=true` if the expected state still matches.
4. Reload or reopen registered runtime gates where safe.
5. Stage the existing restart reason and restart the worker when required.

### Disable

1. Claim confirmation and recheck role.
2. Close the feature start gate and stop registered runtime work.
3. Atomically set `enabled=false`, retaining `installed=true`.
4. Restart the worker when required so boot composition reflects persisted state.

If teardown fails, the flag is not changed and the current state remains authoritative. If restart dispatch fails after a toggle, the persisted flag remains authoritative, the feature receives restart guidance where needed, and unrelated features remain manageable. No package uninstall, purge, or autoremove command is called.

## Verification and restart matrix

| Feature | Readiness checks | Install restart | Toggle restart |
|---|---|---|---|
| Digital inputs | `pigpiod` binary, service, reachable socket | Worker | Worker |
| CO₂ sensor | UART boot configuration and accessible serial device | Host if boot configuration changed; otherwise worker | Worker |
| Zigbee devices | Mosquitto packages and service readiness | Worker | Worker |
| Motion camera | Motion/FFmpeg binaries, config/hooks, service, media paths, required groups | Supervisor if group membership changed; otherwise worker | Worker |
| Live camera streams | FFmpeg/cloudflared runtime, root-owned policy/units/helper, safe directories, required groups | Supervisor if group membership changed; otherwise worker | Worker |

Zigbee readiness means only that the supported local MQTT dependency is ready. It does not claim a coordinator or Zigbee2MQTT gateway is installed or paired.

Enabled features are verified on boot, before mutation, and after installation. A failed boot verification sets an allowlisted attention reason and gates the affected feature without blocking other features.

## Setup and upgrade behavior

The existing pairing boundary remains unchanged. The setup wizard never displays a permanent feature-management credential.

First install:

1. Pair and validate the Telegram bot through the existing flow.
2. Show only the five available features.
3. Write the selected features to `features.json`.
4. Run fixed installer routines.
5. Atomically rewrite `features.json.enabled` to contain only features whose installation and verification succeeded.
6. Start the worker; the existing seeder marks only that verified list installed and enabled.
7. Preserve the existing one-time admin-claim flow.

Installation failures remain visible in terminal output and do not produce `installed=true` database rows. Existing deployments need no new secret or local rotation step.

The machine installer and system updater install the root helper and units atomically with fixed ownership and modes. A helper version mismatch disables new installs with localized update guidance while list, enable, disable, and verification remain available where safe.

## Error handling and logging

Expected errors use typed domain errors and localized interface mappings. Generic replies never expose exception messages, paths, command output, package responses, or systemd details.

Logs may contain job ID, canonical feature, state transition, restart scope, and allowlisted failure category. They never contain Telegram user/chat IDs, bot tokens, credentials, `.env`, workflow payloads, or raw request bodies.

Output is bounded. Package transcripts stream to the system journal rather than worker memory.

## Localization

Add every new user-facing string to English, Russian, and Ukrainian catalogs, including:

- feature labels, descriptions, states, and impact;
- confirmation and restart copy;
- progress stages and safe failure categories;
- needs-attention and verify-again guidance;
- stale-control recovery;
- pre-restart and recovered outcomes;
- direct-command usage and unavailable-feature responses.

Handlers always use `ctx.localeState.catalog` and never import English as the runtime response source.

## Testing strategy

### Domain and application

- catalog visibility and state/action derivation;
- expected-state CAS for enable, disable, and install;
- active-install uniqueness and terminal slot release;
- readiness and attention-state derivation;
- per-feature runtime availability mapping;
- enable/disable never invoking the install helper;
- disable retaining `installed=true` and never uninstalling;
- install success, safe failure, uncertain partial failure, and restart-dispatch failure;
- boot reconciliation from queued and running jobs;
- notification failure not changing terminal job state.

### Infrastructure

- atomic request/result writes and root-only claim behavior in temporary directories;
- file size, type, ownership/mode, link, symlink, and path-traversal rejection;
- strict schemas and unknown-key rejection;
- fixed feature routine selection and sanitized environment;
- bounded output and timeout behavior;
- Drizzle active-slot and terminal-state behavior;
- first-install verified-success rewrite of `features.json`.

### Interfaces and runtime gates

- admin-only five-feature list and hidden legacy entries;
- localized detail and action-specific confirmation;
- stale, duplicate, expired, mismatched, and superseded callbacks;
- direct commands entering the same workflow;
- disabled sensor types absent from setup and blocked at effect boundaries;
- active Digital/UART/MQTT drivers torn down on disable;
- Motion and RTSP work stopped by their lifecycles;
- recovered outcome retries without holding the install slot.

CI uses no real apt, sudo, systemd, PM2, reboot, Motion, cloudflared, GPIO, UART, or network-dependent commands.

## Acceptance criteria

- Administrators can open a localized five-feature list from Admin tools.
- `neobox` and `4g` appear in neither setup nor Telegram feature management.
- Each consistent state exposes exactly one valid mutation.
- Every mutation requires current admin authorization and an action-specific confirmation.
- Only installation crosses the fixed root-owned helper boundary.
- Enable and disable use application-layer gates and never invoke package installation.
- Disabled features stop their runtime work and contribute no controls.
- First-install failures never seed a feature as installed or enabled.
- One installation runs at a time; every terminal outcome releases the global slot.
- A damaged feature gates only itself and can be re-verified without rerunning package work.
- Restart or Telegram delivery failure never blocks unrelated feature management.
- Recovered outcomes are at-least-once and duplicate-safe.
- English, Russian, and Ukrainian catalogs cover every new response.
- Automated tests use no real privileged commands or hardware.

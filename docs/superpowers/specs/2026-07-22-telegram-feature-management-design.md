# Telegram Feature Management Design

**Date:** 2026-07-22

**Status:** Proposed for user review

**Scope:** Interactive Telegram feature management, privileged dependency installation, feature-specific verification and restart, dynamic operational menu contributions, initial-setup secret provisioning, localization, recovery, and tests

## Summary

Telegram gains an admin-only **Features** workflow under **Admin tools**. It lists the five implemented features—Digital, UART/CO₂, Zigbee, Motion, and RTSP—with their installed and enabled state. Selecting a feature shows its impact and exactly one valid mutation: **Install & enable**, **Enable**, or **Disable**.

Every mutation requires the current administrator to enter a per-worker **Admin approval code**. The code is generated during first installation, displayed on the literal first local setup page, and stored as `FEATURE_ADMIN_SECRET` in the mode-`0600` `.env`. Authorization is short-lived, single-use, and bound to the exact administrator, private chat, workflow receipt, feature, and action. Text commands enter the same workflow and cannot bypass it.

Package and service changes run in a root-owned systemd oneshot job, not in the Nest process. The worker persists an operation ledger, submits a strict request to a root-owned helper, independently verifies the result, updates feature state only after successful verification, announces the restart, and reconciles the terminal outcome after boot. Disable stops feature-specific work and services but never uninstalls packages.

Enabled features contribute their existing operational controls elsewhere in Telegram. Disabled controls disappear from freshly rendered menus. A stale button explains which feature is disabled and gives the current user an authorized recovery destination.

## Goals

- Make feature discovery and state understandable without typed commands.
- Allow an administrator to install missing dependencies, enable an installed feature, or disable a feature from Telegram.
- Require a fresh, exact-action approval-code challenge for every mutation.
- Keep privileged package and service work outside the worker process.
- Recover deterministically from worker crashes, PM2 restarts, systemd failures, and host reboots.
- Verify feature-specific postconditions before exposing operational controls.
- Automatically perform the required worker, supervisor, or host restart after clearly disclosing it.
- Never uninstall packages when disabling a feature.
- Keep direct commands and interactive buttons on one localized workflow.
- Preserve the Pi memory budget by bounding output and avoiding buffered package logs.

## Non-goals

- Implementing Neobox or 4G support.
- Adding new operational subsystems for features that have no existing Telegram operation.
- Installing or configuring a Zigbee coordinator or Zigbee2MQTT itself. This slice verifies the currently supported Mosquitto/MQTT dependency only.
- Building a general package manager, terminal, arbitrary command runner, or generic sudo broker.
- Supporting simultaneous feature mutations.
- Rolling back apt transactions or removing partially installed packages.
- Importing feature mutations from YAML. Feature state remains export-only through the existing config snapshot path.
- Claiming that Telegram message deletion removes notification previews, forwarded copies, or messages visible on other clients.

## Approved product decisions

1. Feature management lives at **Home → More → Admin tools → Features**.
2. The feature selector is one flat list of five full-width buttons, not grouped or paginated.
3. `neobox` and `4g` are hidden from both initial setup and Telegram feature management.
4. Only existing operational controls are contributed by enabled features.
5. Disabled operational controls disappear from freshly rendered menus.
6. Stale controls explain that their feature is disabled instead of failing silently.
7. Every mutation requires a fresh approval-code challenge; there is no unlocked session.
8. Direct `/feature` mutation commands use the same challenge and confirmation workflow.
9. Successful install, enable, and disable operations restart automatically.
10. The restart scope is feature-specific: worker, PM2 supervisor, or full Pi reboot.
11. Disable never uninstalls packages.
12. The first-install setup page may display the generated approval code before pairing because the accepted deployment model treats the loopback/local setup page as administrator-controlled.

## Product vocabulary

User-facing copy uses household language first and implementation identifiers second.

| Canonical name | Primary label | Description |
|---|---|---|
| `digital` | Digital inputs | GPIO-based contact, alarm, leak, power, motion, and button sensors |
| `uart` | CO₂ sensor | Serial/UART CO₂ monitoring |
| `zigbee` | Zigbee devices | Existing MQTT-backed sensor setup and local Mosquitto dependency |
| `motion` | Motion camera | Motion detection, snapshots, recorded events, and Motion daemon controls |
| `rtsp` | Live camera streams | RTSP source setup and on-demand live streaming |

Environment-variable names, systemd, sudo, PM2, receipts, and spool files never appear in normal Telegram copy.

## Product invariants

1. Only a currently authorized administrator in a private bot chat may start or confirm a feature mutation.
2. Read-only feature listing does not require the approval code.
3. There is at most one active feature mutation across the deployment.
4. An approval authorizes one exact `(administrator, chat, receipt, feature, action)` tuple.
5. Approval expires after three minutes and is consumed atomically by confirmation.
6. Three failed code attempts cancel the draft and start a ten-minute per-administrator cooldown.
7. Role is rechecked before accepting the code and again before claiming confirmation.
8. Feature state changes only after the privileged result and application-level verification agree.
9. Install success sets `installed=true` and `enabled=true`.
10. Enable retains `installed=true` and sets `enabled=true`.
11. Disable retains `installed=true` and sets `enabled=false`.
12. A failure before `applied` leaves the previous feature flags unchanged.
13. A restart or recovery failure after `applied` retains the verified desired flags but gates operational controls until recovery completes.
14. External package or configuration changes may be partial and are never described as rolled back.
15. A failed external operation re-verifies the previous capability; if readiness cannot be proven, the feature enters **Needs attention** and contributes no operational controls.
16. No privileged helper accepts an arbitrary command, path, package, service, environment variable, or shell fragment.
17. Fresh menus derive operational controls from current verified feature state and unresolved operation status.
18. Every operational callback rechecks current feature state before invoking its use case.
19. A successful mutation is not terminal until post-restart recovery is verified and reported.

## Information architecture

```text
Home
└── More
    └── Admin tools
        ├── Sensor setup
        ├── Storage & backup
        ├── System
        ├── Create invite
        └── Features
            ├── Digital inputs
            ├── CO₂ sensor
            ├── Zigbee devices
            ├── Motion camera
            └── Live camera streams
```

The five-feature screen uses one full-width button per row for mobile scanning. The message body repeats a compact status summary, so status is visible without opening each feature.

## Feature states and actions

Telegram presents three normal states:

| Persisted state | Display | Detail action |
|---|---|---|
| `installed=false`, `enabled=false` | `⬇ Not installed` | **Install & enable** |
| `installed=true`, `enabled=false` | `⏸ Installed · off` | **Enable** |
| `installed=true`, `enabled=true` | `✅ Enabled` | **Disable** |

`enabled=true` with `installed=false` is invalid. The query projection reports it as inconsistent, hides operational controls, and requires verification or manual repair rather than guessing an action.

Two temporary or exceptional states override the normal projection:

| Operation condition | Display | Behavior |
|---|---|---|
| Active mutation before terminal recovery | `⏳ Changing…` | Ordinary mutations and operational controls are unavailable |
| Unresolved partial change or recovery failure | `⚠ Needs attention` | Operational controls remain gated; only exact recovery or local inspection guidance is offered |

The feature detail message contains, before any approval-code prompt:

- primary label and canonical name;
- current state;
- required or verified dependencies;
- operational controls that will appear or disappear;
- monitoring or camera impact;
- expected downtime;
- required restart scope;
- the one valid mutation.

The confirmation label names both effect and restart, for example:

- **Install Motion camera & restart**
- **Enable Digital inputs & restart**
- **Disable Live camera streams & restart**
- **Install CO₂ sensor & reboot Pi**

Generic **Confirm** is not used for feature mutations.

## Approval-code workflow

### Provisioning

The setup wizard generates 32 random bytes and encodes them as a canonical base64url value for `FEATURE_ADMIN_SECRET` when the one-shot wizard starts.

- The literal first loopback setup page displays the code with instructions to save it.
- The code is never written to the setup URL or application logs.
- The value remains in wizard memory until successful final submission.
- `writeConfig` stores it exactly once in the mode-`0600` `.env` beside the bot and admin-claim credentials.
- If setup is abandoned, the value is not persisted; the next run generates a different value.
- `neobox` and `4g` do not appear in the wizard feature selector.

Existing deployments without `FEATURE_ADMIN_SECRET` remain read-only. Telegram explains that local provisioning is required. The TTY-only `scripts/rotate-feature-admin-secret.sh` command generates a new value, atomically updates the mode-`0600` `.env`, and prints the value once. It never sends the value to Telegram or writes it to logs.

### Challenge

Selecting a mutation or typing a mutation command creates a contextual workflow receipt and prompts for the **Admin approval code**. The prompt repeats the feature and action and states that the bot will attempt to delete the reply.

On text receipt:

1. Resolve the exact active workflow by user, private chat, and receipt.
2. Recheck the current role.
3. Read the text into a bounded buffer.
4. Compare the supplied value to the configured secret in constant time.
5. Attempt to delete the Telegram message in a `finally` block.
6. Never echo, persist, or log the supplied value.

A successful comparison creates an in-memory one-use authorization with a three-minute expiry. It stores no secret-derived value. It is bound to:

```text
administrator + private chat + workflow receipt + feature + action
```

Back navigates before authorization. After authorization, the control is **Cancel change**; it removes only the exact draft and authorization and confirms that no feature state changed.

### Attempts and cooldown

- Each challenge permits three failures.
- The third failure closes the exact workflow and begins a ten-minute per-administrator cooldown.
- Cooldown state is in memory and does not create a permanent account lockout.
- A worker restart clears cooldown but does not authorize an operation.
- Expiry copy states: “Approval expired after 3 minutes. No feature state changed.”

## Direct commands

Supported commands are:

```text
/feature list
/feature install <name>
/feature enable <name>
/feature disable <name>
```

`/feature list` opens the localized interactive list without requesting the code.

Mutation commands validate the name and current state, then open the same feature detail, challenge, and confirmation workflow as buttons. They never call a mutating use case directly. If the typed action is not valid for the current state, Telegram opens the detail screen with the one valid action instead of exposing a second mutation path.

Commands targeting `neobox`, `4g`, or another unavailable name receive localized “That feature is not available” copy without enumerating hidden catalog entries.

## Operational menu contributions

Feature status is resolved in application use cases through the exported feature query port. Telegram renderers never query Drizzle directly.

| Enabled feature | Existing controls contributed |
|---|---|
| `digital` | Digital sensor type in Add Sensor |
| `uart` | UART/CO₂ sensor type in Add Sensor |
| `zigbee` | Existing MQTT-backed sensor type used for Zigbee/MQTT devices |
| `motion` | Motion snapshot, events, status, and daemon controls |
| `rtsp` | RTSP source management and compatible live-stream controls |

Camera appears in Home when at least one verified camera capability is enabled. Its dashboard contains only actions supported by the current `motion` and `rtsp` combination.

When a feature becomes disabled:

- its controls disappear from every fresh menu;
- any feature-specific in-flight start gate closes before state is persisted;
- already-running feature work is stopped according to the registered disable lifecycle;
- an old callback performs no effect and explains which feature is off;
- administrators receive a **Features** recovery button;
- members receive **Home** because they cannot manage features.

## Architecture

The work extends the existing `features` bounded context and preserves hexagonal dependencies.

### Domain

Add pure types and errors for:

- visible catalog metadata;
- feature action (`install`, `enable`, `disable`);
- operation and restart states;
- strict request and result shapes;
- approval expiry and binding;
- feature unavailable or inconsistent state;
- operation conflict;
- privileged request rejection;
- installation, verification, restart, and recovery failures.

Catalog metadata distinguishes an internally known feature from a user-available feature. `neobox` and `4g` remain recognizable for legacy rows but have `available=false`. Every user-facing selector filters by availability.

### Application

Focused use cases and services own orchestration:

- **ListManageableFeaturesUseCase** merges available catalog entries with persisted state.
- **GetFeatureDetailUseCase** computes the one valid action, impact, contributions, and restart disclosure.
- **VerifyFeatureAdminSecretUseCase** validates the bounded code through a credential port.
- **BeginFeatureOperationUseCase** performs the state CAS and inserts the durable operation.
- **SubmitFeatureOperationUseCase** publishes the exact request and starts the systemd job.
- **ReconcileFeatureOperationUseCase** reads external status/results and advances the operation idempotently.
- **VerifyFeaturePostconditionsUseCase** runs the per-feature application-visible checks.
- **ApplyFeatureOperationUseCase** changes feature flags only after verification.
- **FeatureDisableLifecycleRegistry** prepares process-local disable work, commits it after state apply, and compensates it on a safe pre-apply failure.
- **RestartForFeatureOperationUseCase** invokes the required restart port after the pre-restart notice is staged.
- **ClaimFeatureOperationOutcomeUseCase** exposes one pending localized outcome to Telegram after recovery.
- **FeatureOperationRecoveryService** reconciles queued, running, verifying, applied, or restarting operations on boot.

Use cases depend only on ports. They do not import `child_process`, filesystem APIs, Drizzle, grammY, or concrete system adapters.

### Infrastructure

Infrastructure adapters provide:

- Drizzle feature-operation repository;
- environment-backed admin credential comparison;
- atomic request spool publisher;
- root-result reader;
- fixed systemd job controller;
- application-visible feature verifiers;
- worker, supervisor, and host restart adapters;
- in-memory repositories and job adapters for tests.

### Telegram interfaces

The feature handler becomes a contextual workflow handler that:

- registers the command and callback grammars;
- invokes role middleware;
- renders localized list, detail, challenge, confirmation, progress, and recovery messages;
- keeps only the bounded, receipt-bound draft and one-use authorization in memory;
- deletes approval-code messages best-effort;
- maps typed errors to locale keys;
- delegates every domain effect to application use cases.

The authoritative Home renderer adds the admin Features destination and receives computed capability contributions as screen data. It does not import the feature repository.

## Privileged systemd boundary

### Installed artifacts

The installer owns these root-controlled artifacts:

```text
/usr/lib/home-worker/feature-manager
/etc/systemd/system/homeworker-feature-manager.service
/etc/systemd/system/homeworker-feature-supervisor-restart.service
/etc/systemd/system/homeworker-feature-host-reboot.service
/var/lib/home-worker/feature-requests/
/var/lib/home-worker/feature-results/
```

The helper and units are root-owned and not writable by the worker account. The worker receives sudo permission only to start the exact fixed units. It cannot pass a command, package, path, environment assignment, alternate unit name, or shell fragment through sudo.

The request ingress directory is `root:homeworker` mode `0730`; the worker can create and atomically publish a named request but cannot enumerate other entries. Published requests are regular files owned by the worker account, mode `0640`, with one link. The result directory is `root:homeworker` mode `0750`; result files are `root:homeworker` mode `0640`, so the worker can read but not alter them.

The normal worker restart continues through the existing process-restarter port. Supervisor restart and host reboot use separate fixed root-owned units with no caller-controlled arguments.

### Request spool

The worker publishes one bounded JSON request through an atomic temporary-file-and-rename operation. The strict schema is:

```ts
interface FeatureJobRequestV1 {
  version: 1;
  operationId: string; // canonical bounded base64url identifier
  feature: 'digital' | 'uart' | 'zigbee' | 'motion' | 'rtsp';
  action: 'install' | 'enable' | 'disable';
}
```

The helper rejects:

- oversized files;
- symlinks, non-regular files, unexpected link counts, or unsafe ownership/mode;
- unknown or duplicate JSON keys;
- non-canonical IDs;
- unavailable features;
- invalid feature/action pairs;
- extra data after the JSON document.

The helper uses a global `flock` and processes at most one operation. It launches fixed per-feature routines through arrays or direct executable arguments, never `sh -c` with request values.

### Result boundary

The root helper writes a bounded, atomic, root-owned result containing:

```ts
interface FeatureJobResultV1 {
  version: 1;
  operationId: string;
  feature: AvailableFeatureName;
  action: FeatureAction;
  outcome: 'succeeded' | 'failed';
  verification: 'passed' | 'failed' | 'not-run';
  failureCode?: FeatureJobFailureCode;
  restartScope: 'worker' | 'supervisor' | 'host';
}
```

`FeatureJobFailureCode` is restricted to `apt-lock-timeout`, `network`, `unsupported-platform`, `dependency-install`, `configuration`, `service-control`, `privileged-verification`, `helper-version`, `request-invalid`, or `internal`. The application independently checks that `restartScope` is valid for the feature and action instead of trusting the result value alone.

Raw apt output, environment values, URLs, credentials, and arbitrary stderr never cross into SQLite or Telegram. Detailed root diagnostics remain in the system journal under normal root-readable retention rules; the application receives only allowlisted categories.

## Durable operation ledger

A new `feature_operations` table belongs to the features context.

| Column | Purpose |
|---|---|
| `id` | Canonical operation identifier |
| `feature_name` | Available catalog feature |
| `action` | `install`, `enable`, or `disable` |
| `requested_by_user_id` | Requesting registered user; never logged |
| `status` | Durable operation state |
| `previous_installed` | CAS/audit snapshot |
| `previous_enabled` | CAS/audit snapshot |
| `active_slot` | `1` while unresolved, otherwise null |
| `restart_scope` | `worker`, `supervisor`, or `host` |
| `failure_code` | Allowlisted safe category or null |
| `created_at` | Unix epoch integer |
| `updated_at` | Unix epoch integer |
| `outcome_notified_at` | Unix epoch integer or null |

Allowed transitions are:

| From | Condition | To |
|---|---|---|
| `queued` | Fixed job accepted | `running` |
| `queued` | Safe pre-execution failure and previous readiness verified | `failed` |
| `queued` | Outcome cannot be proven | `manual-required` |
| `running` | Root result succeeded | `verifying` |
| `running` | Root result failed and previous readiness verified | `failed` |
| `running` | Partial external state prevents verification | `manual-required` |
| `verifying` | Desired postconditions pass | `applied` |
| `verifying` | Desired checks fail but previous readiness is verified | `failed` |
| `verifying` | Neither previous nor desired readiness can be proved | `manual-required` |
| `applied` | Pre-restart outcome staged | `restarting` |
| `applied` | Restart dispatch fails | `recovery-failed` |
| `restarting` | Recovery and terminal delivery succeed | `completed` |
| `restarting` | Restart or readiness fails | `recovery-failed` |
| `recovery-failed` | Exact restart/readiness retry begins | `restarting` |
| `recovery-failed` | Automatic recovery is no longer provably safe | `manual-required` |
| `manual-required` | Verify again proves the previous state | `failed` |
| `manual-required` | Verify again proves the desired state | `applied` or `restarting`, according to restart state |

`failed` means the previous feature capability was re-verified and the previous flags remain authoritative. `recovery-failed` means desired flags were already applied but restart/readiness has not completed. `manual-required` means partial external work prevents either old or desired readiness from being proven automatically.

Every unresolved row stores `active_slot=1`; terminal `completed` and `failed` rows store null. A unique index on `active_slot` therefore enforces one unresolved operation while allowing any number of terminal rows because SQLite permits multiple nulls. Transitions clear the slot only when the operation becomes terminal. Migration files are generated from `src/database/schema.ts`; they are never hand-edited.

No approval code, submitted code, chat ID, raw output, package list, credential, or arbitrary error message is stored.

## Operation lifecycle

### Confirmation to job start

1. Claim the exact one-use authorization.
2. Recheck current role and workflow receipt.
3. In an immediate transaction, verify the expected feature state and absence of another active operation.
4. Insert the `queued` operation with its previous state.
5. For disable, prepare registered process-local lifecycles: close new-work gates and stop receipt-bound running sessions without changing feature flags.
6. Atomically publish the request.
7. Start the fixed systemd feature-manager unit.
8. Render named progress stages; never show invented percentages.

Disable lifecycle preparation is idempotent and operation-bound. If a pre-apply failure leaves the previous external capability verifiably ready, the application compensates the exact preparation—for example, reopening the RTSP start gate. If previous readiness cannot be restored and verified, the operation becomes `manual-required` and controls remain gated.

### Root execution

The root helper:

1. obtains the global lock;
2. validates and claims the exact request;
3. performs an idempotent fixed routine;
4. performs privileged postcondition checks;
5. writes the atomic result even for a recognized failure;
6. exits with a status consistent with the result.

Install routines may add packages or configuration. Enable routines activate already installed configuration without reinstalling. Disable routines stop applicable services and runtime work but never invoke apt removal, purge, autoremove, or file deletion outside explicitly temporary runtime state.

### Application verification and state apply

The reconciler reads both systemd state and the matching result. A claimed `succeeded` result is necessary but not sufficient. The application verifier independently checks observable readiness.

After verification:

- install atomically sets `installed=true`, `enabled=true`;
- enable atomically sets `enabled=true` while requiring `installed=true`;
- disable atomically sets `enabled=false` and retains `installed=true`.

The update includes the previous-state CAS. A mismatch fails closed and does not overwrite newer state.

After a disable flag is applied, the lifecycle registry commits the exact preparation so its start gates remain closed until restart. A worker crash resets process-local gates from persisted feature state during composition; it never infers state from a lost in-memory draft.

### Restart and completion

The operation stages a localized pre-restart message, persists `restarting`, and invokes its disclosed restart scope:

- **worker:** existing PM2 worker restart;
- **supervisor:** fixed systemd unit restarts the PM2 supervisor so new Unix groups apply;
- **host:** fixed systemd unit reboots the Raspberry Pi when UART hardware activation requires it.

After boot, recovery verifies both process health and feature readiness. Telegram then claims the pending outcome exactly once and sends, for example:

```text
✅ Motion camera enabled
Home Worker is back online. Camera controls are now available.
```

Only after successful recovery and terminal delivery does the operation become `completed`. Duplicate delivery attempts are receipt/operation bound and harmless. If restart launch or post-restart readiness fails after `applied`, the desired flags remain stored, the operation becomes `recovery-failed`, and operational controls stay hidden until an exact recovery retry succeeds or local inspection resolves it.

## Boot and crash recovery

On every boot, the recovery service examines the single active operation:

| Durable state | Recovery behavior |
|---|---|
| `queued` | Check for request/result; start the fixed job if safely pending |
| `running` | Inspect systemd state and result; wait, resume idempotently, or fail with a safe category |
| `verifying` | Re-run application verification; never reinstall solely because the worker restarted |
| `applied` | Stage the pre-restart outcome if missing, persist `restarting`, and invoke the disclosed restart |
| `restarting` | Verify worker/feature recovery and publish the pending terminal outcome |
| `recovery-failed` | Keep desired flags, gate controls, and retry only the safe restart/readiness step |
| `manual-required` | Gate controls and provide local inspection guidance; **Verify again** may reconcile after an administrator repairs the Pi locally, but never reruns package work automatically |

The helper treats a stale claimed request without a terminal result as resumable only when its fixed routine is idempotent. If safety cannot be proven, it writes or exposes `manual-inspection-required`; the application does not blindly rerun it.

A feature mutation never starts while another active row exists, even after a worker restart. Systemd and `flock` provide a second cross-process guard; SQLite is the application authority.

## Feature verification and restart matrix

| Feature | Required checks | Normal restart scope |
|---|---|---|
| Digital inputs | `pigpiod` binary, service state, and reachable socket | Worker |
| CO₂ sensor | UART configuration and accessible serial device | Host when hardware changes require it; otherwise worker |
| Zigbee devices | Mosquitto packages and service readiness | Worker |
| Motion camera | Motion and FFmpeg binaries, Motion config/hooks, service, and writable media paths | Worker |
| Live camera streams | FFmpeg/cloudflared runtime, root-owned policy/units/helper, safe directories, and group membership | Supervisor when group membership changes; otherwise worker |

Verification reports only supported readiness. In particular, Zigbee success means the local MQTT dependency is ready; it does not claim that a coordinator or Zigbee2MQTT gateway has been installed or paired.

## Progress and outcome copy

Long operations use truthful named stages with a start time or elapsed time:

```text
Preparing
Installing packages
Configuring services
Verifying
Saving feature state
Restarting Home Worker
```

No fake percentage is shown. The progress message states that package installation may take several minutes and that leaving the workflow does not cancel running work.

Failure copy distinguishes:

- **Feature state:** whether previous flags remain, desired flags were applied but recovery is incomplete, or state requires inspection.
- **System state:** whether packages or configuration may have changed partially.
- **Retry safety:** safe retry, wait and retry, or manual inspection required.
- **Recovery actions:** Retry, Feature details, and Home as authorized.

The approval-code message-deletion failure uses honest copy: the bot could not remove the message and the administrator should delete it manually. It never repeats the submitted value.

## Error handling

Application use cases throw typed feature-domain errors. Infrastructure adapters translate recognized filesystem, process, result-schema, and systemd failures at their boundary. Unexpected errors propagate to the interface boundary after safe logging.

Expected errors include:

- feature unavailable;
- feature state inconsistent;
- action invalid for current state;
- approval missing, invalid, expired, consumed, or mismatched;
- administrator role changed;
- operation already active;
- request rejected;
- privileged unit unavailable;
- install or service action failed;
- privileged verification failed;
- application verification failed;
- restart failed;
- post-restart recovery incomplete;
- manual inspection required.

Telegram catches every declared domain error and replies through locale keys. Generic errors never expose `error.message`, command output, paths, package repository responses, or systemd details.

## Logging and secret handling

- Never log `FEATURE_ADMIN_SECRET`, the submitted code, `.env`, bot tokens, credentials, chat IDs, or raw request bodies.
- Logs may contain the operation ID, canonical feature, action, durable transition, restart scope, and allowlisted failure category.
- Root and application output is bounded; the worker never buffers an apt or installer transcript.
- Approval comparison uses a constant-time primitive over fixed-length digests.
- The env adapter rejects a missing, blank, duplicated, or malformed configured value and disables mutations while preserving read-only listing.
- Approval-code drafts and cooldowns are in memory; durable operations never contain secret material.

## Localization

Every new user-facing string is added to English, Russian, and Ukrainian catalogs. This includes:

- feature labels and descriptions;
- all three status labels;
- impact and restart-scope copy;
- approval prompt, deletion warning/failure, attempt count, cooldown, expiry, and cancellation;
- progress stages;
- partial-install and manual-inspection outcomes;
- stale operational-control recovery;
- pre-restart and post-restart messages;
- direct-command usage and unavailable-feature responses.

The handler always selects `ctx.localeState.catalog`; it never imports the English catalog as its runtime response source.

## Setup, installation, and upgrade behavior

### First install

The setup wizard:

1. generates the pairing secret, claim-admin token, and feature admin secret independently;
2. displays the feature admin secret on the first local page;
3. accepts the existing pairing secret and bot token flow;
4. shows only available features on the selection page;
5. stores `FEATURE_ADMIN_SECRET` in `.env` only after final validation;
6. installs selected feature dependencies through the installer path;
7. preserves the existing one-time admin-claim completion flow.

### Root artifact installation

The machine installer and privileged system updater install root artifacts atomically with root ownership and fixed modes. Application code never overwrites them directly.

The helper exposes a version/capability value. If the running application requires a newer helper, feature mutations fail closed with localized “system helper update required” guidance while feature listing remains available.

### Existing installations

Upgrades do not silently invent a Telegram approval code that the administrator cannot retrieve. Until a local TTY reset command provisions the code, the Feature screen remains read-only and explains the local recovery step.

Legacy `neobox` and `4g` database rows are preserved for compatibility but are absent from setup and every Telegram feature selector. Direct mutation attempts fail as unavailable.

## Testing strategy

### Domain unit tests

- available versus hidden catalog features;
- three valid presentation states and inconsistent-state fail-closed behavior;
- valid action derivation;
- capability contribution mapping;
- approval binding and expiry;
- operation transition table;
- strict request/result decoding;
- restart-scope derivation.

### Application use-case tests

Use in-memory ports and a fixed clock to cover:

- read-only list without approval;
- exact-action authorization and atomic consumption;
- three failures and cooldown;
- role change before confirmation;
- operation conflict;
- expected-state CAS;
- install, enable, and disable success;
- disable retaining `installed=true`;
- no package uninstall call;
- privileged success followed by application verification failure;
- partial failure preserving previous feature flags;
- partial failure entering `manual-required` when previous readiness cannot be proved;
- idempotent reconciliation from every active state;
- `recovery-failed` gating controls while retaining applied desired flags;
- **Verify again** reconciling only a provable previous or desired state;
- restart scope and pre-restart staging;
- post-boot outcome claim and duplicate-delivery safety.

### Infrastructure tests

Without real sudo, apt, systemd, or hardware:

- atomic request and result writes in temporary directories;
- file size, type, ownership/mode abstraction, and symlink rejection;
- strict JSON schemas and unknown-key rejection;
- operation-ID/path traversal rejection;
- fixed executable arguments and sanitized environment;
- systemd controller calling only allowlisted fixed units;
- bounded timeout and output behavior;
- Drizzle repository state transitions, active-operation uniqueness, and recovery queries;
- unique `active_slot` behavior across unresolved and terminal operation rows;
- env secret validation and constant-time digest comparison;
- root helper dry-run fixtures for each allowlisted feature/action/failure category.

### Telegram interface tests

- admin-only Features destination;
- flat five-button list and hidden `neobox`/`4g`;
- localized list/detail rendering;
- impact disclosure before the code prompt;
- code deletion success and failure;
- no secret echo in any reply;
- expiry, cooldown, cancel, and role-change paths;
- action-specific confirmation labels;
- duplicate, stale, mismatched, and superseded callbacks;
- direct commands delegating to the same workflow;
- disabled operational controls absent from fresh menus;
- stale feature callbacks returning Features for admins and Home for members;
- progress stages, partial failure, pre-restart, and post-restart outcomes.

### Setup-wizard tests

- feature secret generation and safe HTML escaping;
- first-page display without URL or log exposure;
- propagation through the paired setup flow;
- atomic mode-`0600` `.env` write;
- abandoned setup not persisting the code;
- hidden unavailable features;
- local TTY recovery/rotation behavior.

### Manual Raspberry Pi acceptance

For every available feature:

1. install from not installed;
2. verify packages/services/hardware postconditions;
3. observe the disclosed restart scope;
4. receive the post-restart online outcome;
5. observe operational controls appear;
6. disable and verify packages remain installed;
7. observe controls disappear;
8. tap a stale control and verify safe recovery;
9. interrupt the worker during root execution and verify boot reconciliation;
10. exercise apt lock timeout, network failure, verification failure, restart failure, and manual-inspection copy.

CI never runs real apt, sudo, systemd, Motion, PM2, cloudflared, GPIO, UART, or reboot commands.

## Acceptance criteria

- An administrator can open a localized five-feature list from Admin tools.
- `neobox` and `4g` appear in neither the first-install selector nor Telegram feature management.
- Every feature detail shows current state, operational impact, downtime, and restart scope before approval.
- Exactly one valid mutation is available for each consistent state.
- Every mutation path requires a fresh, exact-action approval code and confirmation.
- The code is displayed on the first setup page and stored only in the protected `.env` after successful setup.
- Direct commands cannot bypass role, approval, confirmation, operation locking, verification, or restart behavior.
- Privileged work runs only through fixed root-owned systemd artifacts and allowlisted feature/action requests.
- Only one mutation runs at a time and it recovers across worker, supervisor, or host restart.
- Successful install and enable operations expose only their verified existing operational controls.
- Disable stops feature work, keeps packages installed, and removes controls from fresh menus.
- Stale controls cannot perform effects and return an authorized explanation/recovery action.
- Partial external failure is reported honestly and never described as rollback.
- Unresolved or recovery-failed features contribute no operational controls until readiness is proved.
- A success always ends with a post-restart “Home Worker is back online” outcome.
- English, Russian, and Ukrainian catalogs cover every new response.
- Automated tests use no real privileged commands or hardware.

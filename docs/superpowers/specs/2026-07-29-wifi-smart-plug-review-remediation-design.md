# Wi-Fi Smart Plug Review Remediation

## Status and Decision

This design replaces the incomplete native TP-Link implementation introduced by
the Wi-Fi smart-plug change set. One pinned `python-kasa` compatibility bridge
will provide discovery and control for both legacy Kasa devices and modern
authenticated Kasa/Tapo devices.

The NestJS worker remains the owner of domain behavior, persistence, encryption,
onboarding, localization, lifecycle management, and events. Python owns only
the reverse-engineered TP-Link wire protocols. The bridge is local-only and
does not use TP-Link cloud control.

## Problem

The reviewed implementation exposes `/discover`, adds Kasa/Tapo sensor types,
and provides a polling/actuation adapter, but it is not safe or complete enough
to ship:

1. Legacy UDP discovery sends the TCP four-byte length prefix, producing an
   invalid UDP frame.
2. Discovery and control cover only the legacy XOR protocol on UDP 9999.
   Authenticated Tapo and newer Kasa devices using the modern discovery and
   KLAP/AES transports are unsupported.
3. Manual IP onboarding fabricates a successful device when verification
   returns `null`.
4. Relay control treats any non-empty datagram as success, ignores protocol
   error results, and changes local state before success is established.
5. Successful onboarding explicitly reloads after `AddSensorUseCase`, even
   though that use case already reloads, and it does not durably complete and
   restore the workflow receipt.
6. Existing-device filtering compares only IP addresses, allowing duplicate
   registration after DHCP address changes.
7. Telegram copy is hardcoded in English, dynamic values are unsafe in
   Markdown, raw exception messages can be shown to users, and the Russian and
   Ukrainian command catalogs omit `/discover`.

The review also found missing single-flight discovery, swallowed discovery
failures, incorrect universal `tapo-wifi` classification, an unsafe loopback
default for missing device IPs, incomplete shutdown handling, a concrete
adapter exported from `SensorModule`, and test coverage that does not exercise
real protocol or workflow contracts.

## Goals

- Discover, verify, read, and switch supported legacy Kasa and authenticated
  Kasa/Tapo smart plugs on the local network.
- Keep TP-Link protocol implementation out of the TypeScript domain and
  application layers.
- Store authentication credentials encrypted at rest and never expose them in
  logs, command arguments, environment variables passed to the helper, sensor
  JSON configuration, or user-facing errors.
- Make manual onboarding prove device identity and connectivity before
  registration.
- Preserve stable identity across DHCP changes and reject duplicate devices.
- Complete the Telegram workflow exactly once and reload the runtime exactly
  once after a successful atomic registration.
- Keep the worker within its Raspberry Pi memory budget by using bounded,
  short-lived helper processes.
- Add deterministic tests that do not require real TP-Link hardware or network
  sockets.

## Non-Goals

- Supporting smart-plug brands other than TP-Link Kasa and Tapo.
- Provisioning a factory-reset device onto Wi-Fi.
- Remote/cloud control through TP-Link services.
- Energy-monitoring metrics, schedules, timers, firmware updates, Matter
  commissioning, or camera/hub features.
- Persisting every DHCP address change. The active adapter may update its
  in-memory target; the stable MAC/device identity remains authoritative.
- Implementing or maintaining XOR, TDP, KLAP, AES, or TP-Link session
  negotiation directly in TypeScript.
- Sharing one credential profile across multiple sensors in the first version.
- Exporting, importing, or restoring smart-plug credentials through the sensor
  configuration JSON.

## Architecture

### Boundary rule

The smart-plug context exposes technology-neutral TypeScript ports. No domain or
application file imports Python process APIs, `python-kasa` data classes, or
transport-specific cryptography.

The infrastructure path is:

```text
SensorDiscoveryService / TpLinkWifiAdapter
                    |
                    v
          TpLinkSmartPlugPort
                    |
                    v
       PythonKasaSmartPlugAdapter
                    |
           versioned JSON over stdio
                    |
                    v
         python-kasa bridge helper
```

`PythonKasaSmartPlugAdapter` is the only TypeScript component allowed to launch
the helper. The helper is the only component allowed to import `kasa`.

### Smart-plug port

Add a smart-plug-specific application boundary with these operations:

- `discover(timeoutMs, credentials?)`
- `verify(localIp, credentials?)`
- `readState(connection, credentials?)`
- `setState(connection, requestedState, credentials?)`

The port returns normalized application records and typed failures. It does not
return raw `python-kasa` dictionaries or unvalidated JSON.

`DiscoveryProviderPort` remains the generic multi-provider discovery boundary.
A TP-Link discovery adapter implements it by delegating to
`TpLinkSmartPlugPort`. The provider name is `tp-link`, not `tapo`, because the
same adapter supports both brands.

### Shared driver

Replace `TapoWifiAdapter` with `TpLinkWifiAdapter`. The driver factory creates
the same adapter for `tapo-wifi` and `kasa-wifi`; the persisted sensor type
still preserves the brand distinction.

The driver depends on:

- `TpLinkSmartPlugPort` for state and relay operations;
- `SmartPlugCredentialPort` for decrypted credentials scoped to the sensor;
  and
- the existing sensor lifecycle/event contracts.

The driver never launches a process or reads encryption keys directly.

### Module composition

`SensorModule` binds ports to infrastructure adapters at the composition root.
It exports application services and required tokens, not the concrete
`PythonKasaSmartPlugAdapter` or discovery adapter. The ports-and-adapters
catalog and Wi-Fi sensor specification must be updated with the final bindings.

## Versioned Bridge Protocol

The helper accepts exactly one JSON object on stdin and emits exactly one JSON
object on stdout before exiting. The envelope includes `version: 1` and one of
four actions:

- `discover`
- `verify`
- `read_state`
- `set_state`

Credentials, when required, appear only inside the stdin JSON. They are never
placed in the executable path, argument vector, inherited environment, stdout,
or stderr. The TypeScript adapter writes the request, closes stdin, and drops
its plaintext references when the operation settles.

Successful responses contain normalized fields only:

- stable device ID when exposed by the library;
- normalized uppercase MAC without separators when available;
- host, model, alias, and Kasa/Tapo classification;
- whether authentication is required;
- non-secret connection metadata needed to reconnect; and
- confirmed relay state for read and write operations.

The helper maps device families reported by `python-kasa`:

- Kasa families and verified legacy Kasa devices become `kasa-wifi`;
- Tapo families become `tapo-wifi`;
- unsupported or ambiguous non-plug families are rejected instead of guessed.

Library-specific connection metadata is treated as untrusted input by
TypeScript. A runtime schema validates its size, keys, scalar types, and
supported protocol values before it can be persisted or reused. Credentials are
explicitly forbidden in this metadata.

Failed responses use a small stable error-code set:

- `credentials_required`
- `authentication_failed`
- `device_unreachable`
- `unsupported_device`
- `bridge_unavailable`
- `bridge_timeout`
- `protocol_failure`

Diagnostic detail stays in bounded, sanitized application logs. It is never
sent directly to Telegram.

## Process and Resource Safety

The first release uses one short-lived Python process per bridge request.
Discovery and relay operations are infrequent, so this avoids permanent sidecar
memory on the Pi.

The TypeScript process adapter enforces:

- an explicit Python executable path;
- an exact helper script path, without shell interpolation;
- `shell: false`;
- a minimal inherited environment;
- bounded stdout and stderr buffers;
- a per-operation deadline;
- termination on timeout, application shutdown, malformed output, or output
  overflow;
- a short forced-termination grace period; and
- cleanup that is idempotent when process exit races shutdown.

Only one discovery process may run per provider at a time. Concurrent Telegram
requests share the in-flight promise. Control operations remain independent so
one unreachable device cannot block another.

The pinned `python-kasa` release and compatible Python runtime are installed by
the deployment workflow, not dynamically by the running worker. Startup
readiness reports a typed integration-unavailable state when the helper,
runtime, or dependency version is missing. Legacy devices do not fall back to
the removed native XOR implementation.

## Device Identity and Configuration

The persisted non-secret sensor configuration contains:

- `host`: last verified local IPv4 address;
- `mac`: normalized factory MAC when available;
- `deviceId`: stable library device identifier when available;
- `model`;
- `provider: "tp-link"`;
- validated non-secret connection metadata; and
- polling interval when explicitly configured.

Missing or invalid `host` is a configuration error. It must never default to
`127.0.0.1`.

Identity comparison uses this order:

1. normalized MAC;
2. stable device ID;
3. verified IP only when neither stable identifier is available.

The same order is used to deduplicate a scan and to remove devices that already
exist in the sensor repository. A changed IP with the same MAC or device ID is
the existing device, not a new candidate.

After repeated communication failures, the active driver performs a bounded
TP-Link discovery and matches the stable MAC first, then device ID. A match may
update the driver's in-memory host and retry once. It may not adopt a host
based only on alias or model.

## Credential Storage

Add a `smart_plug_credentials` table keyed by `sensor_id`, with a cascading
foreign key to the active sensor row:

- `ciphertext`
- `nonce`
- `auth_tag`
- `key_version`

The migration is generated from `src/database/schema.ts` with
`yarn db:generate`; generated migration files are never hand-edited.

`SmartPlugCredentialPort` exposes store, load, and delete operations without
revealing database representation. Its AES-256-GCM adapter follows the existing
camera credential pattern but remains owned by the sensor context. Associated
data includes a context label, sensor ID, and key version so ciphertext cannot
be moved between sensors or credential contexts.

Environment configuration uses dedicated smart-plug encryption keys:

- `SMART_PLUG_CREDENTIALS_KEY`
- `SMART_PLUG_CREDENTIALS_KEY_VERSION`
- `SMART_PLUG_CREDENTIALS_PREVIOUS_KEYS`

Keys must be valid 32-byte hexadecimal values. Unknown versions, malformed
Base64, invalid nonce/tag lengths, authentication failure, or malformed
plaintext produce a typed credential-unavailable error. No fallback plaintext
storage is allowed.

Legacy devices that do not require authentication can be registered without a
credential row. Authenticated devices cannot be registered unless encryption
is configured and credential verification succeeds.

### Atomic registration

Introduce a smart-plug onboarding use case and transactional registration port.
The Drizzle implementation inserts the sensor and optional encrypted credential
in one database transaction. The operation commits both rows or neither.

The onboarding use case owns name validation, duplicate-device validation,
feature readiness, final device verification, encryption, registration, and
one runtime reload. The Telegram handler must not call `ReloadSensorsUseCase`
separately.

This specialized path is necessary because the generic `AddSensorUseCase`
cannot atomically create a sensor and its credential. Generic sensor creation
continues using `AddSensorUseCase`; shared validation rules should be extracted
only where needed to avoid divergent name and feature checks.

The database transaction is the irreversible success boundary. If the
subsequent runtime reload fails, the sensor and credential remain committed as
the source of truth. The use case returns a typed
`registered_but_activation_failed` outcome, and Telegram reports that the plug
was saved but requires a worker restart or retry to become active. It must not
retry registration or create a duplicate row.

Credential rows never appear in sensor configuration export. Until a dedicated
credential rebind flow exists, configuration import rejects `tapo-wifi` and
`kasa-wifi` sensor entries and directs administrators to `/discover`. This
prevents an imported authenticated sensor from being enabled without its
credential and avoids embedding secrets in portable configuration.

## Discovery and Verification Behavior

`SensorDiscoveryService` distinguishes success from failure:

- a successful scan with no supported devices returns an empty list;
- total provider failure throws a typed discovery error;
- when multiple providers exist later, successful results may be returned if
  at least one provider succeeds, while failed providers are logged safely;
- an unavailable provider is not silently treated as an empty network.

Manual input is parsed with a local-IPv4 value object. It accepts RFC 1918 and
link-local IPv4 addresses and rejects malformed, unspecified, loopback,
multicast, broadcast, and public addresses.

Manual verification returns one of:

- verified without credentials;
- credentials required, with verified public device metadata;
- verified with supplied credentials; or
- a typed unreachable, authentication, protocol, or unsupported-device error.

There is no `verified ?? fabricatedDevice` fallback. A sensor can enter the
naming and registration steps only after the bridge has positively identified
a supported plug.

## Relay State and Polling

The bridge `set_state` action performs the library operation and returns the
confirmed relay state after refresh. The TypeScript adapter considers the
operation successful only when the response schema is valid and the confirmed
state equals the requested state.

`TpLinkWifiAdapter` updates `state`, `lastReadingAt`, and emits a transition
event only after confirmed success. An authentication error, protocol error,
timeout, malformed helper result, or mismatched state leaves the prior local
state unchanged.

Polling uses bounded exponential backoff and must not overlap for one driver.
Failures increment the backoff counter but do not manufacture an OFF reading.
Successful reads reset the counter. `destroy(context)` stops future polls,
aborts or waits for in-flight bridge operations according to the existing
shutdown deadline, and prevents late completions from emitting events.

## Telegram Onboarding

`DiscoverHandler` remains an admin-only `TelegramHandler` and
`WorkflowDraftCanceller` using `WorkflowEntryCoordinator`. It is restricted to
private chats.

The flow is:

1. Begin `sensor-discover` and show TP-Link scan or manual-IP choices.
2. Scan through the single-flight TP-Link provider.
3. Remove already-registered devices using stable identity.
4. Select a verified candidate or enter a local IP.
5. If authentication is required, collect TP-Link username and password.
6. Verify credentials without echoing them.
7. Collect and validate the sensor display name.
8. Revalidate the current receipt and call `markRunning` immediately before
   atomic registration.
9. Execute the smart-plug onboarding use case.
10. Clear ephemeral state and use `WorkflowNavigationHandler.complete` to
    deliver the localized outcome and restore the workflow origin.

Credential messages are deleted from the private chat on a best-effort basis
as soon as they are received. The bot explains that Telegram transports the
plaintext before local encryption. Credentials are never echoed, included in
callback data, or retained after cancellation, supersession, success, or
failure. JavaScript strings cannot be securely zeroed, so the handler minimizes
their lifetime and removes all references promptly.

Once `markRunning` succeeds, replayed callbacks cannot start a second
registration. Name or credential validation errors that occur before this point
keep the draft resumable. Failures after the irreversible boundary produce a
localized terminal failure and restore origin through the same completion
path.

## Localization and Telegram Safety

All onboarding labels, prompts, progress messages, success messages, and error
messages live in the locale catalogs with English, Russian, and Ukrainian
parity. `/discover` appears in all three admin command catalogs.

Dynamic aliases, sensor names, models, IP addresses, and error-safe parameters
must not be interpolated into Markdown source. Prefer plain text or Telegram
entities; if a parse mode is retained, use the repository's format-specific
escaping helper. Raw exception messages are never user-facing.

Error mapping is explicit:

- no devices found;
- no new devices found;
- invalid/non-local IP;
- credentials required;
- authentication failed;
- device unreachable;
- unsupported device;
- bridge unavailable;
- discovery timed out;
- duplicate device;
- invalid or duplicate name;
- credential encryption unavailable; and
- generic retry-safe failure.

## Testing Strategy

### TypeScript unit and application tests

- Validate strict helper request/response schemas and reject extra credential
  fields in non-secret metadata.
- Verify process invocation uses `shell: false`, stdin for credentials, bounded
  output, timeouts, termination, and sanitized errors.
- Verify concurrent discovery calls share one in-flight bridge request.
- Distinguish empty discovery from provider failure.
- Deduplicate by normalized MAC, then device ID, then IP fallback.
- Verify manual IP validation rejects public, loopback, malformed, multicast,
  unspecified, and broadcast targets.
- Prove manual verification never creates a candidate from a failed result.
- Test Kasa and Tapo classification fixtures, including a newer Kasa device
  using a modern transport.
- Test missing-host configuration failure rather than loopback fallback.
- Verify read and write failures do not change state or emit events.
- Verify successful toggle uses the confirmed state and emits exactly one
  transition.
- Verify polling does not overlap and teardown suppresses late events.
- Verify MAC-based rediscovery adopts only the matching stable identity.
- Test AES-GCM round trips, associated-data binding, key rotation, malformed
  fields, wrong keys, and unavailable configuration.
- Test atomic registration rollback for sensor and credential failures and
  prove one successful registration triggers one reload.
- Test the committed-but-not-activated result when runtime reload fails.
- Verify configuration export omits credentials and configuration import
  rejects both smart-plug sensor types.
- Test workflow receipt validation, `markRunning`, callback replay,
  cancellation, completion, origin restoration, and removal of ephemeral
  credential state.
- Test localized error mapping and command/catalog parity for English, Russian,
  and Ukrainian.
- Test aliases and names containing Telegram formatting characters without
  malformed output.

All network-facing TypeScript tests use injected bridge/process seams. They do
not open UDP/TCP sockets or require network sandbox permissions.

### Python helper tests

Use Python's standard test tooling and mocked `python-kasa` objects to cover:

- discovery normalization;
- Kasa/Tapo family classification;
- authentication-required and authentication-failed mapping;
- supported-plug filtering;
- verified direct-host lookup;
- confirmed state reads and writes;
- versioned request validation;
- one-response stdout discipline; and
- redaction of credentials from failures.

Captured, anonymized library fixtures may be added for supported plug families.
No fixture may contain credentials, device IDs, MAC addresses, aliases, public
IP addresses, or other household identifiers.

### Verification gates

Run on the repository-pinned Node 20 and Yarn 4.13 toolchain:

1. focused smart-plug bridge, discovery, credential, adapter, onboarding, and
   locale tests;
2. the complete `test/sensors` and relevant Telegram workflow suites;
3. targeted ESLint without autofix;
4. `yarn build`;
5. the full test suite in an environment that permits its expected local socket
   operations; and
6. a Raspberry Pi smoke test against at least one legacy Kasa plug and one
   authenticated Tapo or modern Kasa plug before release.

Known unrelated full-suite failures must be recorded separately; they do not
waive focused failures in this change.

## Operational Documentation

Update the Wi-Fi sensor specification, dependency-injection catalog,
ports-and-adapters catalog, environment-variable documentation, Pi installation
steps, and readiness troubleshooting.

The installation path must pin the Python dependency, create or update its
isolated environment during deployment, and validate the helper version before
the worker is restarted. The running service never invokes `pip` and never
downloads code.

Logs may include operation name, duration, sanitized error code, sensor ID, and
masked/local host context. They must not contain Telegram chat IDs, TP-Link
usernames, passwords, credential hashes, bridge request bodies, `.env`
contents, raw helper exceptions, or complete household device inventories.

## Acceptance Criteria

- Legacy Kasa and authenticated Tapo/modern Kasa plugs use the pinned
  `python-kasa` bridge; no direct XOR/KLAP/AES implementation remains.
- Discovery supports both families and classifies them correctly.
- Manual IP entry cannot register an unverified or non-local target.
- Authenticated devices require successfully verified, AES-GCM-encrypted
  credentials.
- Sensor and credential rows commit atomically.
- A post-commit reload failure is reported without retrying registration.
- Portable configuration never contains smart-plug credentials and cannot
  import an unauthenticated smart-plug record.
- Duplicate detection survives DHCP address changes.
- Relay state changes only after confirmed device success.
- Discovery is single-flight and exposes provider failures distinctly from an
  empty result.
- The adapter validates its host and shuts down without late polling events.
- Successful onboarding reloads once, completes its durable workflow once, and
  restores the correct origin.
- All user-facing copy is localized for English, Russian, and Ukrainian and no
  raw exception or unsafe Markdown is emitted.
- The sensor module exports ports/application services rather than concrete
  TP-Link infrastructure adapters.
- Focused tests, lint, build, and applicable full-suite verification pass on
  the pinned toolchain, followed by the two-family Pi smoke test.

## Finding Traceability

| Review finding | Design resolution |
|---|---|
| Invalid UDP framing | Remove native UDP framing; all protocols use `python-kasa`. |
| Modern Tapo/auth missing | Pinned bridge supports discovery negotiation and authenticated transports. |
| Fabricated manual verification | Use discriminated verification outcomes; never synthesize a device. |
| Toggle accepts any response | Require schema-valid, confirmed post-write state before mutation/event. |
| Duplicate reload/incomplete workflow | Atomic onboarding use case reloads once; handler marks running and completes through workflow navigation. |
| IP-only deduplication | Compare normalized MAC, then stable device ID, then IP fallback. |
| Hardcoded/unsafe Telegram output | Complete locale parity, safe formatting, typed error mapping, no raw exceptions. |
| Concurrent discovery and swallowed failure | Single-flight execution and explicit empty-versus-failure semantics. |
| Wrong type classification | Map verified Kasa/Tapo device families and reject ambiguous devices. |
| Loopback default and weak teardown | Validate required local host and bind in-flight work to shutdown. |
| Concrete adapter export | Keep infrastructure concrete types private to module composition. |
| Shallow tests | Add bridge contracts, protocol fixtures, credential, lifecycle, and workflow tests. |

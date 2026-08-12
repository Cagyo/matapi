# RTSP Local-Network Installation and Telegram Camera Setup — Design

## Status

Approved on 2026-08-13 and amended after the implementation pressure test on
the same date. The restart handoff, network-drift enforcement, reinstall path,
concurrency fences, prompt durability, and typed probe failures below are
normative parts of the approved design.

This design fixes the RTSP feature-install failure, makes RTSP camera setup
discoverable from the Camera dashboard, and hardens the complete Telegram
source-management workflow. It supersedes the operation-first RTSP source
menu described by the existing live-camera implementation where the two
designs differ.

## Problem

RTSP installation currently requires a non-empty `RTSP_ALLOWED_CIDRS` value,
but the setup wizard only writes `LIVE_STREAM_ENABLED`. The example environment
leaves `RTSP_ALLOWED_CIDRS` blank. Selecting or installing RTSP therefore fails
unless an operator edits the environment manually before installation.

The Telegram bot already has `/camera sources`, but Camera Dashboard has no
entry for it. The source workflow also assumes that the administrator knows an
existing camera name. An RTSP-only installation does not seed a camera row, so
the workflow cannot attach the entered address to anything.

The existing source menu exposes Add, Edit, Test, List, and Remove as equal
top-level operations. It hides current source state, gives no probe progress,
collapses configuration failures into generic copy, falls back to English in
Russian and Ukrainian, and treats credential-message deletion as an implicit
best effort rather than an explicit privacy contract.

## Goals

- Install RTSP without manual environment editing when the Pi has an active
  directly connected private LAN.
- Restrict camera traffic to the Pi's detected local networks. Do not infer or
  permit routed remote networks, public ranges, or arbitrary private ranges.
- Show an admin-only RTSP Sources action in Camera Dashboard only after RTSP is
  installed, enabled, restarted, and application-ready.
- Let an administrator create an RTSP camera by entering its display name and
  RTSP/RTSPS address through Telegram.
- Make RTSP Sources status-first, with contextual actions and actionable empty,
  loading, success, and failure states.
- Preserve the existing sandbox, encrypted credential storage, redaction, and
  feature-availability gates.
- Provide complete English, Russian, and Ukrainian behavior.

## Non-goals

- Cameras reachable only through a routed VLAN, VPN, public network, or custom
  manually entered CIDR.
- Automatic policy broadening when the Pi moves to another network.
- Persistent public streaming, custom domains, or a new Cloudflare model.
- Support for protocols other than RTSP and strict RTSPS.
- A general camera CRUD system outside RTSP source setup.
- Guaranteed removal of a credential message from Telegram. The bot can only
  attempt deletion and must state that limitation before input.

## Decisions

1. The installer derives policy from active, directly connected private routes.
   It does not use all RFC 1918 ranges as a broad default.
2. Telegram never modifies privileged network policy. It configures sources
   only inside the already-installed policy.
3. RTSP Sources appears only for administrators and only when RTSP readiness
   succeeds. `/camera sources` remains the direct expert entry point and applies
   the same role/readiness checks.
4. RTSP Sources opens on current status, not an operation picker.
5. Adding a new RTSP camera probes first and then atomically creates the camera,
   source metadata, and encrypted credential.
6. Test connection is non-mutating. Change address probes before replacing the
   saved source.
7. A newly created `type: rtsp` camera is removed with its source. Removing a
   source attached to a Motion camera leaves the Motion camera intact.
8. Installed network policy is bound to eligible physical interfaces as well as
   CIDRs. Runtime grants revalidate the current route and nftables rules bind the
   destination to the installed output interface.
9. RTSP installation is a durable two-stage transition: privileged completion,
   then supervisor restart, then application readiness. The feature is not
   marked installed or enabled before the post-restart check passes.
10. An installed RTSP feature has an explicit Reinstall on current network
    action. Policy drift never relies on the ordinary first-install transition.
11. Camera display-name uniqueness uses a persisted canonical key, and every
    source replacement or removal uses revision-based compare-and-swap.
12. Credential prompt metadata and expired-prompt tombstones are durable and
    non-secret. A received credential reply is deletion-attempted before the
    network probe begins.
13. Probe failures cross the Camera boundary as a closed typed error set. Raw
    FFmpeg or resolver diagnostics never cross that boundary.

## Architecture

The change stays inside the existing Features, Camera, and Telegram bounded
contexts.

- A root-owned fixed network-policy inspector discovers eligible routes, emits
  only canonical non-secret policy projections, and verifies the installed
  projection against current link state. The privileged feature routine stages
  and installs the corresponding private runtime policy.
- Features owns RTSP installation outcomes and readiness. Its adapters inspect
  fixed artifacts; no Telegram handler shells out or reads privileged files.
- Camera owns camera registration, source probing, encrypted persistence,
  overview data, testing, replacement, stream teardown, and removal.
- Telegram is an interface adapter. It renders localized state and invokes
  application use cases through receipt-bound conversations.

No interface or application class imports a camera or feature infrastructure
adapter directly.

## Installer-Derived LAN Policy

### Route discovery

`iproute2` becomes a core installer prerequisite so route discovery is already
available before any RTSP-specific package mutation. Installer/helper upgrades
on existing deployments install and verify that prerequisite before exposing
runtime RTSP installation. The fixed root routine obtains JSON route and link
state through an absolute allowlisted `ip` executable.

An eligible network must satisfy all of these rules:

- The route is in the main table, is unicast, has `scope link`, has a concrete
  destination prefix, and has no gateway.
- Its device is administratively up, has carrier, is not `lo`, and is a
  device-backed physical Ethernet or Wi-Fi link. Bridge, bond, veth, tun/tap,
  WireGuard, Docker/container, and other virtual or tunnel link kinds are
  rejected even when they expose a private `scope link` route.
- IPv4 is within `10.0.0.0/8`, `172.16.0.0/12`, or `192.168.0.0/16`; IPv6 is
  within unique-local `fc00::/7`.
- The network is not loopback, link-local, multicast, unspecified, or a default
  route.

The inspector parses every prefix with strict network semantics, canonicalizes
it, pairs it with the validated interface name, removes duplicate
`(interface, prefix)` pairs, and sorts first by address family and network and
then by interface. Interface names must be canonical kernel names of at most 15
bytes and must match their JSON link record exactly. Multiple active
Ethernet/Wi-Fi LANs are allowed. At least one eligible network is required.

The same root-owned inspector executable is used in two fixed modes:

- `discover` emits the canonical eligible-network projection for installation;
- `verify-installed` reads the fixed public summary artifact, rediscovers the
  current projection, and emits only `ready`, a closed reason code, the digest,
  and the redacted interface/subnet summary.

It accepts no paths, commands, CIDRs, or interface names from Telegram or the
worker. Raw `ip` JSON remains in the root journal on failure.

No active eligible network fails before installing FFmpeg, nftables, polkit, or
cloudflared with the sanitized feature failure
`local-network-unavailable`.

### Durable artifacts

From one canonical network projection, the installer prepares:

- `RTSP_ALLOWED_CIDRS=<canonical comma-separated list>` in the private worker
  environment;
- `/etc/home-worker/live-stream-policy.json`, retaining mode `0600` and root
  ownership, with version, worker/stream UIDs, interface-bound networks, and the
  UDP media range;
- `/etc/home-worker/live-stream-policy.summary.json`, a root-owned mode `0644`,
  single-link, non-secret artifact containing the same version, UIDs,
  interface-bound networks, UDP range, and policy digest; and
- `RTSP_POLICY_DIGEST=<digest>` in the private worker environment.

The digest is SHA-256 over the canonical JSON encoding of every
security-relevant policy field: version, worker UID, stream UID,
`(interface, CIDR)` pairs, and UDP range. Application readiness opens the public
summary with no-follow/single-link/owner/mode/size checks, confirms that its
CIDRs and UDP range equal the worker-visible environment, compares the digest to
`RTSP_POLICY_DIGEST`, and invokes `verify-installed` to compare the installed
projection with current routes. The root network helper independently verifies
that the private policy and public summary describe the same canonical object.

The environment update uses the existing no-follow, single-link, owner, and
mode checks. It replaces any previous `RTSP_ALLOWED_CIDRS` and policy digest
with the freshly detected local networks, preserves the credential key when it
is valid and non-empty, generates the key only when absent, and preserves all
unrelated settings.

The inspector output, private policy, public summary, and environment update are
all staged and validated before any RTSP-specific package mutation. After
dependencies install, each durable output is written to a same-directory
private file, flushed, validated, and atomically renamed. The three-file commit
cannot be globally atomic; its order is private policy, public summary, then
environment. A crash may temporarily create disagreement, but readiness and the
runtime helper fail closed and an idempotent reinstall reconciles all artifacts.

### Installation and restart outcome

The privileged helper distinguishes these sanitized RTSP failures from an
ordinary package failure through reserved routine exit statuses:

- `20` → `local-network-unavailable`
- `21` → `network-policy-generation-failed`
- `22` → `dependency-install-failed`
- `23` → `privileged-verification-failed`

The RTSP routine maps discovery-with-no-result to `local-network-unavailable`
and malformed/staging output to `network-policy-generation-failed`; both occur
before package or durable-artifact mutation and are reconciliation-safe.
Package commands map to `dependency-install-failed`. A zero routine status
followed by a failed root verification maps to
`privileged-verification-failed`; failures after the first durable rename are
also treated as privileged-verification failures. All other nonzero routine
statuses map to dependency failure. The result schema, domain failure union,
safe-failure classification, persistence, and locale catalogs are extended
together. Raw route output and package diagnostics remain in the root journal
and are never delivered through Telegram.

RTSP installation retains supervisor restart scope because both PM2 and the
worker must receive `homeworker-stream` group membership and reload the
installed policy. A successful privileged result moves the durable job from
`running` to `awaiting-restart` while retaining the global active slot and root
result. The worker records its current process identity before dispatching the
fixed supervisor-restart unit. The identity is
`<linux-boot-id>:<proc-self-start-ticks>`, read through a Features-owned port
from the two fixed procfs files. Recovery behaves as follows:

1. In the same process identity, it waits for the dispatched restart and does
   not run application readiness or dispatch repeatedly.
2. In a new process identity, it runs application readiness. Readiness success
   terminalizes the job, marks the feature installed and enabled, removes the
   root result, opens the RTSP start gate, and delivers the final outcome.
3. If readiness still reports missing process group membership, recovery records
   the new identity and dispatches the supervisor restart once more. Any other
   readiness failure terminalizes with the typed failure and preserves the
   previous installed/enabled state.
4. A restart-dispatch failure leaves the job recoverable with
   `restart-required`; an administrator retry dispatches the same fixed unit.

Only the post-restart terminal transaction marks the feature installed and
enabled.

### Reinstall on the current network

Feature Management exposes `Reinstall on current network` for RTSP when it is
already installed. The action is also offered from stale-policy guidance. It
creates an install job with an exact expected previous installed/enabled state,
uses the same global active slot and two-stage restart protocol, and never
deletes camera sources. Before publishing the privileged request, the existing
RTSP runtime lifecycle closes the start gate and stops RTSP sessions. A
pre-mutation discovery or staging failure preserves the previous policy and
feature state and reopens the gate only if the old policy still passes current
readiness. A failure after durable mutation marks the feature
`partial-state-uncertain` and keeps RTSP start-gated until a later reinstall or
verification succeeds.

### Readiness

RTSP readiness continues to verify FFmpeg, cloudflared, root-owned runtime
artifacts, runtime directory ownership/modes, the active network helper, and
the current worker process's group membership. It additionally:

1. Parses and canonicalizes the worker-visible `RTSP_ALLOWED_CIDRS`.
2. Safely reads and validates the fixed public policy summary.
3. Computes the complete policy digest and compares it to
   `RTSP_POLICY_DIGEST` and the summary digest.
4. Invokes the fixed inspector in `verify-installed` mode and rejects a changed
   CIDR, interface, link kind, carrier state, route scope, gateway, UID, or UDP
   range.
5. Rejects an empty, malformed, broad, public, or inconsistent policy.

At grant time the network helper also resolves each destination's current route
and requires the installed interface with no gateway. Generated nftables rules
include the installed output-interface name. Readiness does not automatically
replace policy after a network change. A changed route or interface therefore
fails closed even when the destination remains inside an old allowed CIDR. The
source UI reports `policy-stale` and links to Reinstall on current network.

## Camera Application Model

### Published operations

Camera exposes focused use cases for:

- obtaining the RTSP source overview and redacted installed-policy summary;
- creating a new RTSP camera and source;
- attaching a source to an existing enabled camera;
- testing an existing source without persistence;
- replacing an existing source after a successful probe;
- removing an RTSP-created camera or detaching a source from another camera;
  and
- stopping active RTSP work before replacement or removal.

The existing media read port remains read-only. A camera-owned write port
publishes the narrow atomic registration/removal operations needed here. The
Drizzle adapter may implement both read and write ports, but consumers depend
on the appropriate port.

`cameras` gains a required canonical `nameKey` with a unique index. The key is
`name.trim().normalize('NFC').toLowerCase().normalize('NFC')`; the original
trimmed display name remains unchanged for presentation.
`camera_live_sources` gains a non-negative `revision`, `verifiedAt`, and
`policyDigest`. Every overview returns the revision and dynamically compares the
saved policy digest and current hostname resolution with the installed policy;
the persisted `ready` bit alone never renders Configured and verified.

The Camera application depends on a published admin-authorization port. Every
mutating use case receives `actorUserId`, checks current admin status before the
probe and again immediately before its final synchronous SQLite transaction,
then checks the RTSP gate epoch and installed policy digest without another
asynchronous boundary. The deployment remains `instances=1`; database CAS is
still authoritative for concurrent Telegram updates.

### Create flow

For a new RTSP camera:

1. Recheck current admin authorization, RTSP availability, the installed policy
   digest, and the process-local start-gate epoch.
2. Validate and normalize a unique display name.
3. Generate a stable opaque camera ID and construct a candidate `type: rtsp`,
   enabled camera without persisting it.
4. Parse the URL, resolve its host, enforce the installed CIDRs, and run the
   bounded restricted probe.
5. Encrypt the validated credential payload.
6. Recheck current admin authorization, RTSP availability, the unchanged policy
   digest, and the unchanged start-gate epoch.
7. Without another asynchronous boundary, use one immediate SQLite transaction
   to insert the camera, source metadata at revision `0`, and credential.

If probing, encryption, availability, uniqueness, or persistence fails, no row
is created. The unique `nameKey` index remains the final authority for
concurrent case- or Unicode-equivalent name attempts. Camera-ID collision and
name-key violations map to typed domain errors at the Drizzle boundary.

Attaching a source to an existing camera uses a camera picker and the camera's
existing ID. It probes and inserts only the source/credential transaction after
rechecking that the camera is still enabled and has no source.

### Test and replacement

Test connection loads the source through the credential port, probes the exact
saved settings, and returns a sanitized typed outcome. It does not update source
metadata, credentials, readiness, revision, `verifiedAt`, or timestamps.

Change address captures the current source revision and keeps the current source
active while validating, probing, and encrypting the candidate. After a
successful probe it stops only active or pending work whose camera ID matches
that source, then atomically replaces metadata and credential only when the
revision still matches. The transaction increments the revision and records the
current policy digest and verification time. A probe, encryption, stop, CAS, or
persistence failure leaves the old source and credential persisted and usable;
an already-stopped live session is not automatically recreated.

### Removal

Removal always requires a confirmation containing the camera display name and
captures the current revision. After the final admin/feature/gate checks, it
stops only active or pending work for that camera and removes data only when the
revision still matches.

- For a camera whose type is `rtsp`, one transaction removes live-source rows,
  credential rows, and the camera row.
- For any other camera type, the transaction removes only RTSP source and
  credential rows.

No plaintext credential is loaded for removal.

Concurrent replacement, attachment, and removal conflicts throw a typed stale
source error and return the administrator to a freshly loaded source detail.

## Telegram Experience

### Camera Dashboard

Camera Dashboard retains Live as its primary camera action. When the current
user is an administrator and `FeatureAvailabilityPort` reports RTSP ready, it
adds a secondary localized `📡 RTSP Sources` button. The callback is
`cam:<receipt-id>:src`; it is validated before delegating to the existing
camera-source interface boundary.

Non-admin users and non-ready RTSP states do not receive the button. Direct
`/camera sources` remains available to administrators and explains the current
feature state if invoked while unavailable.

### Status-first Sources screen

The landing message contains:

- the title `RTSP Cameras`;
- `Local network only` plus redacted interface/subnet summaries;
- one line/button per configured source, using a localized operational state;
- `Add RTSP camera`; and
- Back and Home.

Persisted overview states use user-facing terms such as Configured and verified,
Credentials required, Not ready, and Needs attention. Transient test/setup
results may additionally say Blocked by local-network policy, Authentication
failed, or another categorized failure without persisting the test. Camera IDs,
credentials, and raw child diagnostics are absent. The list is bounded and
paginated before Telegram keyboard size becomes unwieldy.

An empty state briefly explains that the camera must be on the Pi's local
network and presents one primary `Add first camera` action. It does not present
Edit, Test, List, or Remove.

Selecting a source shows its display name, redacted host, status, and the
contextual actions Test connection, Change address, Details, and the correctly
named removal action. Details contains transport/profile and the redacted
policy relationship, not credentials.

### Add flow

The first decision is `Create RTSP camera` or `Attach to existing camera` when
an eligible existing camera is available. With no existing cameras, creation
starts directly.

Creation asks for a unique display name through ForceReply. The state records
the exact prompt message ID, receipt, user, private chat, and ten-minute expiry.
Only a reply to that prompt advances the flow.

Before URL input, the bot states:

- accepted schemes are RTSP and strict RTSPS;
- the host must resolve inside the displayed local networks;
- the URL may contain camera credentials;
- Telegram is not a secret channel;
- the bot will attempt to delete the reply but cannot guarantee deletion; and
- the prompt expires in ten minutes.

The URL prompt is another ForceReply bound to its exact message ID and receipt.
Prompt state is stored through a Telegram-owned port in SQLite and contains only
user, private chat, receipt, exact prompt message ID, non-secret camera
selection/name, phase, and expiry. It never contains a URL or credential.

On a matching reply, the handler durably changes the prompt to `running`, copies
the text only into the current call stack, and immediately attempts to delete
the exact Telegram message. It then sends `Testing connection…` and invokes the
create/attach use case. A deletion failure is remembered as a non-secret boolean
so the terminal message can identify the exact reply by context and ask the
administrator to remove it manually.

The immediate deletion attempt runs for success, validation failure, role
change, and feature change because it occurs before those effects. A narrow
`finally` retries deletion if the first attempt failed. The URL remains only in
the bounded stack/Camera call and is never copied into prompt state, receipt
payload, logs, callbacks, or error objects.

The prompt store retains non-secret expired/consumed credential-prompt
tombstones for 24 hours, capped at 100 records per administrator. On process
startup it retries deletion for interrupted `running` prompts before expiring
them. A late reply to a retained prompt is not processed; deletion is attempted
and the bot offers `Start again`. Arbitrary RTSP-looking messages that are not
replies to a known prompt are not claimed.

### Error recovery

Typed errors map at the Telegram boundary to these safe categories:

- invalid RTSP/RTSPS address;
- address outside the installed local-network policy;
- camera name already exists;
- host not found or unreachable;
- authentication rejected;
- TLS verification failed;
- unsupported stream;
- probe timed out;
- RTSP feature changed or became unavailable; and
- policy is stale after a Pi network change.

The probe port exposes one typed error per category. DNS lookup and installed
policy checks map directly. The FFmpeg adapter runs with a fixed `LANG=C`,
captures at most 64 KiB of stderr, classifies only an allowlisted set of stable
patterns for authentication, TLS, unsupported video, and timeout, then discards
the diagnostic buffer. Unrecognized process failures map to the existing
generic probe failure. No diagnostic text is attached as an error cause.

An error retains only non-secret context such as the proposed display name or
selected camera. It offers the applicable Retry, Change address, Back, or
Reinstall RTSP guidance. No URL, username, password, token, resolved hostname,
raw route output, child stderr, or nested exception text appears in Telegram,
application logs, callbacks, or persisted workflow state.

### Localization

`camera.sources` becomes mandatory in `LocaleCatalog`. English, Russian, and
Ukrainian implement identical keys for dashboard entry, overview, policy
summary, empty state, progress, prompts, privacy warning, confirmation,
categorized errors, recovery actions, status labels, and expiry.

Action grammar uses closed semantic keys rather than interpolated English words.
Cancel buttons are authoritative; localized typed cancel synonyms are accepted
only while an exact text prompt is active.

## Security Properties

- Telegram cannot broaden the privileged network allowlist.
- The installed policy contains only active directly connected private networks.
- Every DNS answer must remain inside the installed policy before probing and
  before streaming; the existing ephemeral UID-scoped egress lease remains
  authoritative.
- RTSP credentials remain encrypted at rest and absent from config export.
- Plaintext exists only in the bounded configure/test/runtime path and is never
  stored in workflow state or camera rows.
- Prompt callbacks and text are bound to the exact user, private chat, receipt,
  and prompt message.
- Feature availability and admin role are rechecked before probing and before
  persistence.
- Mutations carry the installed policy digest, start-gate epoch, and source
  revision through the probe and fail on any mismatch before the SQLite effect.
- Active streams stop before replacement or removal.
- A network change never automatically widens access.
- Runtime egress is bound to both approved destinations and approved physical
  output interfaces.

## Verification

### Installer and readiness

Tests cover one Wi-Fi/Ethernet subnet, multiple direct private subnets,
deterministic canonical ordering, and rejection of public, loopback, link-local,
multicast, unspecified, default, inactive-interface, carrier-down,
gateway-routed, bridge, bond, veth, tun/tap, WireGuard, and container entries.
No eligible network must fail before any RTSP-specific package installation.

Environment tests prove owner/mode/no-follow enforcement, key preservation,
replacement of stale CIDRs, unrelated-setting preservation, digest parity,
interrupted three-file replacement, and idempotent recovery. Privileged and
application readiness tests cover every artifact, service, group, directory,
interface, current-route, policy-field, and digest mismatch. Install recovery
tests prove the `running → awaiting-restart → succeeded` path, same-process
waiting, one dispatch per process identity, post-restart group verification,
dispatch retry, and reinstall preservation/failure behavior.

### Application and persistence

Use-case and SQLite integration tests prove:

- successful probe creates camera, source, and encrypted credential atomically;
- probe failure creates no rows;
- duplicate camera names fail safely, including concurrent attempts;
- case- and Unicode-equivalent names collide through `nameKey`;
- attaching to an existing camera does not replace the camera row;
- Test connection performs no writes;
- failed replacement preserves the old source and credential;
- successful replacement stops active work before its atomic commit;
- concurrent replace/replace, replace/remove, and attach/attach attempts produce
  one commit and one typed stale-source result;
- RTSP-camera removal deletes camera/source/credential together;
- Motion-camera detachment preserves the camera; and
- feature, policy, gate-epoch, and role changes prevent the next effect.

### Telegram and locales

Handler tests cover the full admin/readiness visibility matrix, direct-command
fallback, empty/populated/paginated overviews, exact ForceReply and receipt
binding, prompt expiry/tombstones, deletion on every terminal path, deletion
failure copy, immediate deletion before probing, restart recovery of interrupted
prompts, bounded 24-hour tombstone retention, progress acknowledgement,
categorized errors, retry/back/home, removal confirmation, stale callbacks,
localized typed cancellation, private-chat enforcement, and the 64-byte
callback limit.

Catalog parity tests require all source keys in English, Russian, and Ukrainian
and reject English fallback for this workflow.

### Target-Pi acceptance

On a Pi connected to its normal LAN:

1. Install RTSP through Feature Management without editing `.env`.
2. Confirm detected CIDRs match only active directly connected private LANs.
3. Confirm supervisor restart and readiness make RTSP Sources visible to an
   administrator and hidden from a normal user.
4. Create a new RTSP camera through Camera Dashboard and open a live view.
5. Confirm a source outside the installed LAN is rejected without an egress rule.
6. Exercise bad credentials, timeout, edit, non-mutating test, and both removal
   semantics.
7. Change or simulate policy drift and confirm fail-closed guidance.
8. Reinstall RTSP on the changed network and confirm sources are preserved but
   dynamically reclassified against the new policy.
9. Scan application logs, root journal excerpts exposed to the app, Telegram
   messages, database rows, exports, and callbacks for credential leakage.

## Acceptance Criteria

- A clean RTSP installation succeeds on a Pi with an active directly connected
  private LAN and no preconfigured `RTSP_ALLOWED_CIDRS`.
- Installation fails early and clearly when no eligible LAN exists.
- Installed policy permits only detected direct private subnets through their
  installed physical output interfaces.
- Privileged success remains non-terminal until a supervisor restart gives the
  worker its runtime group and application readiness passes.
- An installed RTSP feature can be reinstalled on the current network without
  deleting camera sources.
- An administrator can create an RTSP camera and set its address entirely
  through Camera Dashboard after RTSP becomes ready.
- Failed creation leaves no camera/source/credential rows; failed replacement
  preserves the working source.
- Concurrent source mutations are revision-safe and equivalent display names
  cannot bypass database uniqueness.
- Source management is status-first, localized, receipt/prompt-bound, and
  recoverable without re-entering non-secret context.
- Test connection does not mutate persisted configuration.
- Credentials never appear in logs, callbacks, exports, or bot output, and the
  bot attempts Telegram deletion before probing, recovers non-secret prompt
  cleanup after restart, and explicitly treats deletion as best effort.
- Normal users never see or invoke RTSP source-management effects.
